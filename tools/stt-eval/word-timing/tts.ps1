# Synthesizes one clip with exact word positions.
#   -Engine onecore : WinRT Windows.Media.SpeechSynthesis (word-boundary TimedMetadataTrack)
#   -Engine sapi    : System.Speech (SpeakProgress + PhonemeReached for word ends)
# Writes <Out>.raw.wav (engine's own format) and <Out>.tts.json:
#   { engine, voice, words: [{ text, start, end|null, charPos }] } — seconds.
# Input is an SSML <speak> document read from -SsmlFile (UTF-8).
param(
	[Parameter(Mandatory)] [ValidateSet("onecore", "sapi")] [string]$Engine,
	[Parameter(Mandatory)] [string]$Voice,
	[Parameter(Mandatory)] [string]$SsmlFile,
	[Parameter(Mandatory)] [string]$Out
)
$ErrorActionPreference = "Stop"
$ssml = [System.IO.File]::ReadAllText($SsmlFile, [System.Text.Encoding]::UTF8)
$words = New-Object System.Collections.ArrayList

if ($Engine -eq "onecore") {
	Add-Type -AssemblyName System.Runtime.WindowsRuntime
	[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
	[void][Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
	$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
		$_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
		$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
	} | Select-Object -First 1
	$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
	$synth.Voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $Voice } | Select-Object -First 1
	if (-not $synth.Voice) { throw "voice not found: $Voice" }
	$synth.Options.IncludeWordBoundaryMetadata = $true
	$task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($synth.SynthesizeSsmlToStreamAsync($ssml)))
	$task.Wait()
	$stream = $task.Result
	# OneCore word cues carry a start only (Duration is 0): ends are derived later.
	foreach ($track in $stream.TimedMetadataTracks) {
		if ($track.Id -ne "SpeechWord") { continue }
		foreach ($cue in $track.Cues) {
			[void]$words.Add([ordered]@{
				text    = $cue.Text
				start   = $cue.StartTime.TotalSeconds
				end     = if ($cue.Duration.TotalSeconds -gt 0) { $cue.StartTime.TotalSeconds + $cue.Duration.TotalSeconds } else { $null }
				charPos = $cue.StartPositionInInput
			})
		}
	}
	$net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
	$fs = [System.IO.File]::Create("$Out.raw.wav")
	$net.CopyTo($fs)
	$fs.Close(); $net.Close()
} else {
	Add-Type -AssemblyName System.Speech
	$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
	$synth.SelectVoice($Voice)
	$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
	$synth.SetOutputToWaveFile("$Out.raw.wav", $fmt)
	$phonemes = New-Object System.Collections.ArrayList
	$synth.add_SpeakProgress({ param($s, $e)
			[void]$words.Add([ordered]@{ text = $e.Text; start = $e.AudioPosition.TotalSeconds; end = $null; charPos = $e.CharacterPosition })
		})
	$synth.add_PhonemeReached({ param($s, $e)
			[void]$phonemes.Add(@($e.AudioPosition.TotalSeconds, $e.Duration.TotalSeconds, $e.Phoneme))
		})
	$synth.SpeakSsml($ssml)
	$synth.SetOutputToNull()
	$synth.Dispose()
	# A word ends where its last non-silence phoneme ends (SAPI phoneme 7 = silence);
	# phonemes are attributed to the word whose start precedes them.
	for ($i = 0; $i -lt $words.Count; $i++) {
		$from = $words[$i].start
		$to = if ($i + 1 -lt $words.Count) { $words[$i + 1].start } else { [double]::MaxValue }
		$end = $null
		foreach ($p in $phonemes) {
			if ($p[0] -ge $from -and $p[0] -lt $to -and ($p[2].Length -eq 0 -or [int]$p[2][0] -ne 7)) {
				$e = $p[0] + $p[1]
				if ($null -eq $end -or $e -gt $end) { $end = $e }
			}
		}
		$words[$i].end = $end
	}
}

$doc = [ordered]@{ engine = $Engine; voice = $Voice; words = @($words) }
[System.IO.File]::WriteAllText("$Out.tts.json", (ConvertTo-Json -Depth 5 $doc), (New-Object System.Text.UTF8Encoding($false)))

//! Bench de la lecture libre de la preview (macOS) : rejoue la boucle de `render_thread` sur
//! un seul clip, à une vitesse donnée, et mesure le retard que la vue prend sur l'horloge.
//!
//! Même arithmétique que `render_thread` : l'accumulateur avance de `dt × vitesse`, `step()`
//! compose chaque frame due jusqu'à `max_steps` par tick (au-delà le reliquat est abandonné),
//! puis relit le RT UNE fois par tick, comme la publication macOS (pas de textures partagées).
//! `dt` est borné à 0,1 s comme dans `render_thread` : un tick plus long perd de l'horloge.
//!
//! Utilisation :
//! `cargo run --release --example live_free_run_bench_macos -- <fichier> [vitesse=4] [secondes=8] [largeur=1920] [hauteur=1080]`

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
	use openscreen_compositor::compositor::Compositor;
	use openscreen_compositor::config;
	use openscreen_compositor::d3d::Gpu;
	use openscreen_compositor::frame_geometry::live_params_from_scene;
	use openscreen_compositor::live::Player;
	use openscreen_compositor::scene::Scene;
	use std::time::{Duration, Instant};

	let mut args = std::env::args().skip(1);
	let path = args.next().unwrap_or_else(|| {
		eprintln!("usage: live_free_run_bench_macos <fichier> [vitesse=4] [secondes=8] [largeur=1920] [hauteur=1080]");
		std::process::exit(2);
	});
	let speed: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(4.0);
	let seconds: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(8.0);
	let width: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1920);
	let height: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1080);

	let source = path.replace('\\', "/");
	let scene_json = format!(
		r##"{{
		"clips": [{{"screenPath":"{source}","webcamPath":"","sourceStartSec":0,"sourceEndSec":100000,"webcamOffsetSec":0,"hasAudio":false}}],
		"layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
		"effects": {{"padding":0.1,"blur":false,"shadow":0.5,"roundnessFrac":0.02,"motionBlur":0.0}},
		"background": {{"kind":"color","color":"#303030"}},
		"zoomRegions": [],
		"speedRegions": [],
		"cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
		"cropByClip": [null],
		"output": {{"width":{width},"height":{height},"fps":30}}
	}}"##
	);

	let gpu = Gpu::create(false)?;
	let mut cfg = config::all().pop().expect("au moins une config");
	cfg.zoom = false;
	cfg.layout_anim = false;
	let comp = Compositor::new_sized(&gpu, width, height)?;
	let scene = Scene::from_json(&scene_json)?;
	comp.set_live_params(live_params_from_scene(&scene));
	comp.set_scene(Some(scene.clone()));
	comp.clear_cursor();

	unsafe {
		let mut player = Player::open(&path, "", &gpu)?;
		player.set_programme_clock(Some(&scene), 0);
		anyhow::ensure!(player.present_frame(&comp, &cfg, 0.0)?, "aucune frame à 0 s");
		// Temps source réellement joué, cumulé frame par frame : un clip plus court que la mesure
		// reboucle à 0 (EOF), et la seule position finale compterait alors une seule passe.
		let mut played = 0.0f64;

		let mut acc = 0.0f64;
		let mut last = Instant::now();
		let t0 = last;
		let (mut ticks, mut adopted, mut capped, mut published) = (0u64, 0u64, 0u64, 0u64);
		// Ce que l'horloge de l'app a parcouru, en temps source : la cible que la vue devrait tenir.
		let mut clock_source = 0.0f64;
		while t0.elapsed().as_secs_f64() < seconds {
			let now = Instant::now();
			let dt = (now - last).as_secs_f64().min(0.1);
			last = now;
			ticks += 1;
			acc += dt * speed;
			clock_source += (now - t0).as_secs_f64() * speed - clock_source;
			let max_steps = ((3.0 * speed.max(1.0)).ceil() as i32).min(64);
			let mut n = 0;
			let mut stepped = false;
			loop {
				let before = player.screen_time_sec();
				if !player.step(&comp, &cfg, before + acc)? {
					break;
				}
				stepped = true;
				adopted += 1;
				let after = player.screen_time_sec();
				played += if after >= before { after - before } else { after };
				acc = if after >= before { (acc - (after - before)).max(0.0) } else { 0.0 };
				n += 1;
				if n >= max_steps {
					capped += 1;
					acc = 0.0;
					break;
				}
			}
			if stepped {
				comp.readback_direct()?;
				published += 1;
			} else {
				std::thread::sleep(Duration::from_millis(4));
			}
		}
		let wall = t0.elapsed().as_secs_f64();
		println!(
			"vitesse {speed}x, {width}x{height}, {wall:.2} s : horloge {:.2} s source, vue {played:.2} s source, retard {:.2} s source ({:.2} s de lecture)",
			clock_source,
			clock_source - played,
			(clock_source - played) / speed
		);
		println!(
			"ticks {ticks} ({:.1}/s), frames adoptées {adopted} ({:.1}/s), plafond atteint {capped} fois, publiées {published} ({:.1}/s)",
			ticks as f64 / wall,
			adopted as f64 / wall,
			published as f64 / wall
		);
	}
	Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
	eprintln!("live_free_run_bench_macos : macOS uniquement");
}

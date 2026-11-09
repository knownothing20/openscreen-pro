//! Le device D3D11 unique du POC (§2).
//! Un seul `ID3D11Device`, feature level 11_1, flag VIDEO_SUPPORT (décodeur),
//! et `ID3D10Multithread::SetMultithreadProtected(TRUE)` — parce que le décodeur
//! ffmpeg et notre boucle de rendu toucheront le device depuis des threads distincts.

use anyhow::{bail, Result};
use std::sync::OnceLock;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_DRIVER_TYPE_WARP,
    D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_DEBUG, D3D11_CREATE_DEVICE_FLAG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1, DXGI_ADAPTER_DESC1,
    DXGI_ADAPTER_FLAG_SOFTWARE,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
    SetupDiGetDeviceRegistryPropertyW, DIGCF_PRESENT, GUID_DEVCLASS_DISPLAY, HDEVINFO,
    SP_DEVINFO_DATA, SPDRP_DEVICEDESC, SPDRP_DRIVER,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ,
};

/// Qui exécute le pipeline. Le rendu et le décodage sont DEUX axes distincts, et aucune
/// plateforme n'a de rastériseur logiciel qui décode aussi la vidéo (WARP ici, lavapipe
/// sous Linux, rien du tout sous macOS) — un backend fixe donc les deux ensemble.
///
/// Le contrat de scène, les shaders HLSL et tout `compositor.rs` sont identiques d'un
/// backend à l'autre : c'est tout l'intérêt. Un portage Metal/Vulkan remplace ce que fait
/// ce fichier et `Decoder`, pas le moteur.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    /// GPU : rastérisation matérielle + décodage D3D11VA sur le même device (zéro copie).
    /// Le seul backend qui puisse exporter — l'encodeur AMF exige lui aussi le vrai GPU.
    Hardware,
    /// CPU : rastérisation WARP + décodage logiciel libavcodec, uploadé en NV12.
    /// Pour les hôtes sans GPU D3D11 utilisable (VM, RDP, Basic Render Driver).
    Cpu,
}

impl Backend {
    fn driver(self) -> D3D_DRIVER_TYPE {
        match self {
            Backend::Hardware => D3D_DRIVER_TYPE_HARDWARE,
            Backend::Cpu => D3D_DRIVER_TYPE_WARP,
        }
    }

    /// WARP REFUSE `VIDEO_SUPPORT` (`DXGI_ERROR_UNSUPPORTED`, mesuré dans
    /// `tests/warp_device_cannot_decode.rs`) : ce flag n'a de sens que sur le device
    /// matériel, où il conditionne D3D11VA. Le backend CPU ne décode pas sur le GPU,
    /// il n'en a donc pas besoin.
    fn base_flags(self) -> D3D11_CREATE_DEVICE_FLAG {
        match self {
            Backend::Hardware => {
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT
            }
            Backend::Cpu => D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        }
    }
}

/// One display adapter, as a user would recognise it in the settings list.
///
/// Two identities, and they are not interchangeable:
///
///  - `luid` is the RUNTIME handle. It is what a device has to be created on, and it is what
///    DXGI changes when a driver updates, a card is re-enumerated, or the session differs. Storing
///    it across restarts is what V2.2 did, and it is why a saved choice can point at a different
///    card (or at nothing).
///  - `stable_id` is the PnP device instance id (`PCI\VEN_..&DEV_..&SUBSYS_..&REV_..\<instance>`),
///    which names the physical device and survives reboots and driver updates. This is what the
///    setting stores.
///
/// `identity_ambiguous` is set when the PnP list cannot be paired one-to-one with a DXGI entry —
/// several identical cards, or an adapter that reports no PCI identity. It is a "do not merge
/// these, and do not promise the choice will survive" flag, not an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterInfo {
    pub index: u32,
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub subsystem_id: u32,
    pub revision: u32,
    pub luid: u64,
    /// PnP instance id, or a PCI key when the instance id could not be established.
    pub stable_id: String,
    /// True when `stable_id` is a model-level key shared with another adapter.
    pub identity_ambiguous: bool,
    /// Driver version from the display class key, when it could be read.
    pub driver_version: Option<String>,
    pub dedicated_video_memory: u64,
    /// A software renderer (WARP, RDP, a virtual display driver) — it can composite but has no
    /// hardware encoder behind it, and saying so is better than listing it as a GPU.
    pub software: bool,
}

impl AdapterInfo {
    pub fn vendor_name(&self) -> &'static str {
        match self.vendor_id {
            0x10DE => "NVIDIA",
            0x1002 | 0x1022 => "AMD",
            0x8086 => "Intel",
            0x1414 => "Microsoft",
            _ => "Other",
        }
    }

    /// A device the compositor fell back to without being able to name it.
    fn unknown() -> Self {
        Self {
            index: 0,
            name: "Unknown adapter".to_string(),
            vendor_id: 0,
            device_id: 0,
            subsystem_id: 0,
            revision: 0,
            luid: 0,
            stable_id: "unknown".to_string(),
            identity_ambiguous: true,
            driver_version: None,
            dedicated_video_memory: 0,
            software: false,
        }
    }
}

/// One display adapter as Windows' device tree knows it.
#[derive(Clone, Debug)]
struct PnpDisplayAdapter {
    instance_id: String,
    description: String,
    driver_version: Option<String>,
}

fn wide_to_string(raw: &[u16]) -> String {
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end])
}

fn utf16_bytes_to_string(buffer: &[u8]) -> String {
    let units: Vec<u16> = buffer
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|&unit| unit != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

/// `DriverVersion` from the display class key named by `SPDRP_DRIVER` (e.g. "0000").
///
/// Optional on purpose: this is presentation (the settings list shows it), and a machine where the
/// key cannot be read is still perfectly able to encode.
fn driver_version_for(class_subkey: &str) -> Option<String> {
    if class_subkey.is_empty() {
        return None;
    }
    let path = format!(
        "SYSTEM\\CurrentControlSet\\Control\\Class\\{{4d36e968-e325-11ce-bfc1-08002be10318}}\\{class_subkey}"
    );
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(wide.as_ptr()), 0, KEY_READ, &mut key).is_err() {
            return None;
        }
        let name: Vec<u16> = "DriverVersion".encode_utf16().chain(std::iter::once(0)).collect();
        let mut kind = REG_SZ;
        let mut size: u32 = 0;
        let ok = RegQueryValueExW(key, PCWSTR(name.as_ptr()), None, Some(&mut kind), None, Some(&mut size));
        if ok.is_err() || size == 0 || size > 512 {
            let _ = RegCloseKey(key);
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let read = RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut kind),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(key);
        if read.is_err() {
            return None;
        }
        buffer.truncate(size as usize);
        let value = utf16_bytes_to_string(&buffer);
        if value.is_empty() { None } else { Some(value) }
    }
}

/// Display adapters from the PnP device tree.
///
/// `EnumDisplayDevicesW` is the obvious call and it is the wrong one here: in an RDP or indirect
/// session it reports the session's own display adapter (16 identical `RDPIDD_INDIRECTDISPLAY`
/// entries on the machine this was written on) and never the physical cards. `SetupDiGetClassDevs`
/// walks the device tree instead, which is where the PCI instance ids live and where a driver
/// update does not change them.
///
/// Cached: a device-tree walk does not change during a session, and this is called per adapter.
fn enumerate_pnp_adapters() -> Vec<PnpDisplayAdapter> {
    static CACHE: OnceLock<Vec<PnpDisplayAdapter>> = OnceLock::new();
    CACHE
        .get_or_init(|| unsafe {
            let mut adapters = Vec::new();
            let Ok(set) = SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_DISPLAY), None, None, DIGCF_PRESENT)
            else {
                return adapters;
            };
            for index in 0..64u32 {
                let mut info = SP_DEVINFO_DATA::default();
                info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
                if SetupDiEnumDeviceInfo(set, index, &mut info).is_err() {
                    break;
                }

                let mut id_buffer = [0u16; 512];
                let mut required: u32 = 0;
                if SetupDiGetDeviceInstanceIdW(
                    set,
                    &info,
                    Some(&mut id_buffer[..]),
                    Some(&mut required),
                )
                .is_err()
                {
                    continue;
                }
                let instance_id = wide_to_string(&id_buffer).to_uppercase();
                if instance_id.is_empty() {
                    continue;
                }

                let mut desc_buffer = [0u8; 512];
                let mut desc_kind = 0u32;
                let description = if SetupDiGetDeviceRegistryPropertyW(
                    set,
                    &info,
                    SPDRP_DEVICEDESC,
                    Some(&mut desc_kind),
                    Some(&mut desc_buffer),
                    Some(&mut required),
                )
                .is_ok()
                {
                    utf16_bytes_to_string(&desc_buffer)
                } else {
                    String::new()
                };

                let mut driver_buffer = [0u8; 512];
                let class_subkey = if SetupDiGetDeviceRegistryPropertyW(
                    set,
                    &info,
                    SPDRP_DRIVER,
                    Some(&mut desc_kind),
                    Some(&mut driver_buffer),
                    Some(&mut required),
                )
                .is_ok()
                {
                    utf16_bytes_to_string(&driver_buffer)
                } else {
                    String::new()
                };

                adapters.push(PnpDisplayAdapter {
                    driver_version: driver_version_for(&class_subkey),
                    instance_id,
                    description,
                });
            }
            let _ = set;
            adapters
        })
        .clone()
}

/// TEMPORARY: the raw PnP adapter list, for diagnosing identity pairing on a real machine.
pub fn debug_pnp_adapters() -> Vec<String> {
    enumerate_pnp_adapters()
        .into_iter()
        .map(|adapter| {
            format!(
                "{} | {} | {}",
                adapter.instance_id,
                adapter.description,
                adapter.driver_version.unwrap_or_else(|| "-".to_string())
            )
        })
        .collect()
}

/// The PCI model fragment both DXGI and the PnP instance id carry, e.g.
/// `VEN_10DE&DEV_2705&SUBSYS_413C1458&REV_A1`.
fn pci_model_key(desc: &DXGI_ADAPTER_DESC1) -> String {
    format!(
        "VEN_{:04X}&DEV_{:04X}&SUBSYS_{:08X}&REV_{:02X}",
        desc.VendorId,
        desc.DeviceId,
        desc.SubSysId,
        desc.Revision & 0xFF
    )
}

/// (stable_id, ambiguous, driver_version) for one DXGI adapter.
///
/// One PnP match means the instance id names this card and nothing else. Several matches mean the
/// machine has two cards of the same model, and the PCI fragment cannot tell them apart: the id
/// falls back to the model, and `ambiguous` says so — the caller must not merge entries on it.
/// Zero matches means the adapter reports no PCI identity (software, virtual, or a driver that
/// hides it); an exact description match is tried once, and the answer stays "ambiguous" either
/// way rather than being invented.
fn stable_identity(desc: &DXGI_ADAPTER_DESC1, name: &str) -> (String, bool, Option<String>) {
    let key = pci_model_key(desc);
    let pnp = enumerate_pnp_adapters();
    let by_pci: Vec<&PnpDisplayAdapter> = pnp
        .iter()
        .filter(|adapter| adapter.instance_id.contains(key.as_str()))
        .collect();
    match by_pci.len() {
        1 => (
            by_pci[0].instance_id.clone(),
            false,
            by_pci[0].driver_version.clone(),
        ),
        0 => {
            let by_name: Vec<&PnpDisplayAdapter> = pnp
                .iter()
                .filter(|adapter| adapter.description.eq_ignore_ascii_case(name))
                .collect();
            match by_name.len() {
                1 => (
                    by_name[0].instance_id.clone(),
                    false,
                    by_name[0].driver_version.clone(),
                ),
                _ => (format!("pci:{key}"), true, None),
            }
        }
        _ => (format!("pci:{key}"), true, None),
    }
}

fn luid_of(desc: &DXGI_ADAPTER_DESC1) -> u64 {
    ((desc.AdapterLuid.HighPart as u32 as u64) << 32) | desc.AdapterLuid.LowPart as u64
}

fn adapter_info(index: u32, desc: &DXGI_ADAPTER_DESC1) -> AdapterInfo {
    let name = String::from_utf16_lossy(
        &desc.Description[..desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len())],
    );
    let (stable_id, identity_ambiguous, driver_version) = stable_identity(desc, &name);
    AdapterInfo {
        index,
        name,
        vendor_id: desc.VendorId,
        device_id: desc.DeviceId,
        subsystem_id: desc.SubSysId,
        revision: desc.Revision,
        luid: luid_of(desc),
        stable_id,
        identity_ambiguous,
        driver_version,
        dedicated_video_memory: desc.DedicatedVideoMemory as u64,
        // Microsoft's "Basic Render Driver" is WARP and is NOT flagged SOFTWARE by DXGI on this
        // platform — it reports as a normal adapter with no VRAM. Both readings are folded in so
        // the UI never offers it as a GPU that could encode.
        software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0
            || desc.VendorId == 0x1414,
    }
}

/// Every adapter DXGI knows about, in the order it reports them (index 0 is the default).
///
/// This is the list the settings screen shows. It says what the machine HAS — not what can
/// encode: whether `h264_nvenc` opens on a given card is a question only an open can answer,
/// which is what the test-encode path is for.
pub fn enumerate_adapters() -> Result<Vec<AdapterInfo>> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut adapters = Vec::new();
        let mut index = 0u32;
        // `EnumAdapters1` returns DXGI_ERROR_NOT_FOUND past the end; that is the loop's stop
        // condition, not an error worth surfacing.
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            let desc = adapter.GetDesc1()?;
            adapters.push(adapter_info(index, &desc));
            index += 1;
        }
        Ok(adapters)
    }
}

/// The adapter a live device is actually running on.
fn adapter_of_device(device: &ID3D11Device) -> Result<AdapterInfo> {
    unsafe {
        let dxgi: IDXGIDevice = device.cast()?;
        // `GetAdapter` hands back the base interface; the descriptor that carries the LUID and
        // the vendor is on the `1` variant.
        let adapter: IDXGIAdapter1 = dxgi.GetAdapter()?.cast()?;
        let desc = adapter.GetDesc1()?;
        Ok(adapter_info(0, &desc))
    }
}

fn find_adapter(luid: u64) -> Result<IDXGIAdapter1> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut index = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            let desc = adapter.GetDesc1()?;
            if luid_of(&desc) == luid {
                return Ok(adapter);
            }
            index += 1;
        }
    }
    bail!("cet adaptateur n'est plus présent (LUID {luid:#x})")
}

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub feature_level: D3D_FEATURE_LEVEL,
    /// Lu par `Decoder::open` pour choisir D3D11VA ou le décodage logiciel. Porté par le
    /// `Gpu` plutôt que passé partout : tout ce qui tient un device sait déjà qui il est.
    pub backend: Backend,
    /// L'adaptateur RÉEL de ce device — pas celui qu'on a demandé. Rend visible dans les logs
    /// et dans le rapport d'export le fait que « GPU: NVIDIA » et « ça encode sur le 780M »
    /// sont deux choses différentes.
    pub adapter: AdapterInfo,
}

/// Une tentative `D3D11CreateDevice` à FL 11_1. Extraite pour que le chemin d'échec
/// puisse re-sonder avec d'autres flags/driver et dire POURQUOI la vraie tentative
/// a échoué (voir `diagnose`), au lieu de remonter un HRESULT nu.
fn try_create(
    adapter: Option<&IDXGIAdapter1>,
    driver: D3D_DRIVER_TYPE,
    flags: D3D11_CREATE_DEVICE_FLAG,
) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext, D3D_FEATURE_LEVEL)> {
    let levels = [D3D_FEATURE_LEVEL_11_1];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let mut got = D3D_FEATURE_LEVEL::default();
    // D3D11 refuses a driver type other than UNKNOWN once an explicit adapter is given — the
    // adapter IS the choice at that point, and passing HARDWARE as well is an error, not a hint.
    let driver = if adapter.is_some() { D3D_DRIVER_TYPE_UNKNOWN } else { driver };
    // The creation entry point takes the base `IDXGIAdapter`; the `1` variant is only needed to
    // read the descriptor.
    let adapter_param: Option<windows::Win32::Graphics::Dxgi::IDXGIAdapter> =
        match adapter {
            Some(adapter) => Some(adapter.cast()?),
            None => None,
        };
    unsafe {
        D3D11CreateDevice(
            adapter_param.as_ref(),
            driver,
            HMODULE::default(),
            flags,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut got),
            Some(&mut context),
        )?;
    }
    // Le SDK garantit les deux sorties quand l'appel réussit ; `E_UNEXPECTED` plutôt
    // qu'un `unwrap` pour que l'impossible reste une erreur, pas un panic.
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context, got)),
        _ => Err(windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)),
    }
}

/// Message d'échec ACTIONNABLE : re-sonde pour distinguer les deux causes réelles.
///
/// Ce message reste utile MÊME maintenant que `create_auto` replie sur le backend CPU :
/// il part dans les logs à chaque repli, et c'est lui qui dit si l'utilisateur subit un
/// pilote à mettre à jour (réparable en cinq minutes) ou une VM sans GPU (structurel).
/// Sans lui, un utilisateur au rendu logiciel ne saurait jamais qu'il lui manque un
/// pilote. Et si WARP échoue aussi, c'est ce message-ci que `create_auto` remonte.
///
/// PR #162 proposait de retomber sur `D3D_DRIVER_TYPE_WARP` en gardant tout le reste.
/// Mesuré (`tests/warp_device_cannot_decode.rs`) : WARP + `VIDEO_SUPPORT` ne se crée même
/// pas (`DXGI_ERROR_UNSUPPORTED`), et sans ce flag il n'expose aucun `ID3D11VideoDevice`
/// (`E_NOINTERFACE`, 0 profil décodeur). Comme `pipeline.rs` passe CE device à ffmpeg
/// comme `AVD3D11VADeviceContext`, un simple changement de driver type aurait produit zéro
/// frame. C'est ce qui a donné à `Backend::Cpu` sa forme : WARP pour le rendu PLUS un
/// décodage logiciel (`cpu_frames.rs`) — le rendu et le décodage sont deux axes.
fn diagnose(err: &windows::core::Error) -> String {
    // Le décodeur est le point de rupture le plus probable (RDP, VM sans passthrough,
    // Microsoft Basic Render Driver) : si l'appel passe SANS VIDEO_SUPPORT, l'adaptateur
    // est là, c'est son décodeur qui manque. La sonde ne garde que BGRA — surtout pas
    // `flags` moins VIDEO_SUPPORT, qui traînerait `DEBUG` avec lui : sans les Graphics
    // Tools de Windows la couche debug fait échouer la sonde aussi, et on accuserait
    // l'adaptateur à tort. Ce cas-là se lit déjà dans `{err}`
    // (`DXGI_ERROR_SDK_COMPONENT_MISSING`), il n'a pas besoin de sa propre branche.
    if try_create(None, D3D_DRIVER_TYPE_HARDWARE, D3D11_CREATE_DEVICE_BGRA_SUPPORT).is_ok() {
        return format!(
            "this display adapter has no D3D11 video decoder ({err}). OpenScreen decodes \
             every preview and export frame with D3D11VA on the same device it composites \
             with, so the decoder is not optional and there is no CPU path behind it. \
             Remote Desktop sessions and VMs without GPU passthrough land here: run on the \
             physical machine, or update the display driver."
        );
    }
    format!(
        "no Direct3D 11 feature level 11_1 display adapter ({err}). OpenScreen's compositor \
         requires one for both preview and export. Update the display driver, or run on a \
         machine with a GPU that reaches feature level 11_1."
    )
}

impl Gpu {
    /// Crée le device conforme au §2. `debug=false` impératif dans tout run mesuré
    /// (§10 : la couche debug valide et sérialise chaque appel — facteur, pas %).
    ///
    /// MATÉRIEL STRICT, sans repli : échoue plutôt que de rendre un device WARP. C'est ce
    /// que veulent les tests et les goldens (mesurer ou comparer le chemin GPU n'a aucun
    /// sens sur un rastériseur logiciel). Le chemin de production, lui, prend `create_auto`.
    pub fn create(debug: bool) -> Result<Gpu> {
        Gpu::create_backend(Backend::Hardware, debug)
    }

    /// Le device de PRODUCTION : matériel si possible, backend CPU sinon.
    ///
    /// C'est ici que le repli devient automatique, et il ne l'est qu'accompagné : l'app
    /// demande `probe()` et prévient l'utilisateur. Un basculement muet vers un rendu à
    /// ~8 fps serait exactement le « l'app rame aujourd'hui » que cette branche corrige.
    ///
    /// Si les DEUX échouent, c'est le diagnostic MATÉRIEL qu'on remonte en tête : c'est
    /// lui qui est actionnable (« pas de décodeur vidéo sur cet adaptateur »), pas
    /// « WARP indisponible », qui ne dit rien à personne.
    pub fn create_auto(debug: bool) -> Result<Gpu> {
        Gpu::create_auto_on(None, debug)
    }

    /// `create_auto`, optionally pinned to one adapter.
    ///
    /// An explicit adapter is a USER choice: if it cannot be used, the old behaviour of falling
    /// back to WARP would defeat the point (the user would be told "your GPU" while the machine
    /// renders on the CPU), so hardware failure with a pinned adapter is an error. Without one,
    /// the historical fallback applies unchanged.
    /// Whether this device is still usable, and why not when it is not.
    ///
    /// A device that has been removed (driver reset, TDR, a driver that lost its adapter) keeps
    /// answering calls, and every one of them fails — which is exactly what the AMD export
    /// failures looked like: a healthy probe, then the first real frame refused with a code
    /// `av_strerror` renders as "Unknown error occurred", while a `0x887A0005` sat in the log
    /// from the first texture upload. Asking DXGI directly is the difference between "the
    /// encoder said no" and "the device is gone", and only the second one is worth rebuilding.
    ///
    /// `None` means healthy. `Some(hresult)` is the reason DXGI reports, unmodified.
    pub fn device_removed_reason(&self) -> Option<u32> {
        match unsafe { self.device.GetDeviceRemovedReason() } {
            Ok(()) => None,
            Err(error) => Some(error.code().0 as u32),
        }
    }

    pub fn create_auto_on(adapter_luid: Option<u64>, debug: bool) -> Result<Gpu> {
        let hw_err = match Gpu::create_backend_on(Backend::Hardware, adapter_luid, debug) {
            Ok(gpu) => return Ok(gpu),
            Err(err) if adapter_luid.is_some() => return Err(err),
            Err(err) => err,
        };
        eprintln!("[d3d] backend matériel indisponible ({hw_err:#}) — repli sur le backend CPU");
        Gpu::create_backend(Backend::Cpu, debug).map_err(|cpu_err| {
            anyhow::anyhow!("{hw_err:#} (le repli logiciel a échoué aussi : {cpu_err:#})")
        })
    }

    /// Le backend que cette machine obtiendra, sans créer de vue ni d'export.
    ///
    /// Mis en cache : créer un device coûte quelques dizaines de ms et la réponse ne
    /// change pas en cours de session (un pilote qui tombe en marche est un redémarrage,
    /// pas un rafraîchissement). `None` = ni matériel ni WARP — la vue échouera, et c'est
    /// son message d'erreur, plus précis, qui doit parler.
    pub fn probe() -> Option<Backend> {
        static PROBED: OnceLock<Option<Backend>> = OnceLock::new();
        *PROBED.get_or_init(|| {
            for backend in [Backend::Hardware, Backend::Cpu] {
                if Gpu::create_backend(backend, false).is_ok() {
                    return Some(backend);
                }
            }
            None
        })
    }

    /// Le device du backend demandé. `Backend::Cpu` ne diagnostique pas : si WARP
    /// lui-même échoue, il n'y a plus rien derrière à proposer.
    pub fn create_backend(backend: Backend, debug: bool) -> Result<Gpu> {
        Gpu::create_backend_on(backend, None, debug)
    }

    /// The device of the requested backend, on `adapter_luid` when one is named.
    ///
    /// `Backend::Cpu` (WARP) ignores the adapter on purpose: it is the software rasteriser, and
    /// asking it for a specific card is a contradiction rather than a refinement.
    pub fn create_backend_on(backend: Backend, adapter_luid: Option<u64>, debug: bool) -> Result<Gpu> {
        let mut flags = backend.base_flags();
        if debug {
            flags |= D3D11_CREATE_DEVICE_DEBUG;
        }
        let adapter = match adapter_luid {
            Some(luid) if backend == Backend::Hardware => Some(find_adapter(luid)?),
            _ => None,
        };

        let (device, context, got) = match try_create(adapter.as_ref(), backend.driver(), flags) {
            Ok(gpu) => gpu,
            Err(err) if backend == Backend::Cpu => {
                bail!("WARP (rastériseur logiciel) indisponible sur cet hôte : {err}")
            }
            Err(err) => bail!("{}", diagnose(&err)),
        };

        if got != D3D_FEATURE_LEVEL_11_1 {
            bail!("feature level obtenu {:?} != 11_1", got);
        }

        // §2 : multithread-protected. Le décodeur ffmpeg soumet depuis son thread,
        // notre compositeur depuis le nôtre — sans ça, corruption silencieuse.
        let mt: ID3D11Multithread = context.cast()?;
        unsafe {
            let _prev = mt.SetMultithreadProtected(true);
            if !mt.GetMultithreadProtected().as_bool() {
                bail!("SetMultithreadProtected(TRUE) n'a pas pris");
            }
        }

        // Read the adapter back off the device rather than trusting what we asked for: a driver
        // is free to hand out a device on a different adapter, and the report must say where the
        // frames actually came from.
        let adapter = adapter_of_device(&device).unwrap_or_else(|_| AdapterInfo::unknown());
        Ok(Gpu { device, context, feature_level: got, backend, adapter })
    }
}

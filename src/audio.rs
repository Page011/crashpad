//! System volume, mute and microphone mute (Core Audio, default devices).

use super::*;
use windows::Win32::{
    Media::Audio::{EDataFlow, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture, eConsole, eRender},
    System::Com::{CLSCTX_ALL, CoCreateInstance, CoInitializeEx, COINIT_MULTITHREADED},
};

#[derive(Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    /// Default output volume, 0.0 – 1.0.
    pub volume: f32,
    pub muted: bool,
    /// Default microphone muted; None when there's no microphone.
    pub mic_muted: Option<bool>,
}

/// Join the MTA on this thread (commands run on the async runtime's workers). Already initialised
/// (S_FALSE) or already an STA (RPC_E_CHANGED_MODE) is fine: Core Audio works from either.
fn com() {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

/// The default console device's volume control for output (eRender) or the microphone (eCapture).
fn endpoint(flow: EDataFlow) -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        devices.GetDefaultAudioEndpoint(flow, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

fn output() -> Res<IAudioEndpointVolume> {
    endpoint(eRender).map_err(|_| "No audio output device".into())
}

fn read(out: &IAudioEndpointVolume, mic: Option<&IAudioEndpointVolume>) -> windows::core::Result<Audio> {
    unsafe {
        Ok(Audio {
            volume: out.GetMasterVolumeLevelScalar()?,
            muted: out.GetMute()?.as_bool(),
            mic_muted: mic.and_then(|m| m.GetMute().ok()).map(|b| b.as_bool()),
        })
    }
}

/// Worth an event: a mute flipped or the volume moved (floats wobble in the last bits).
fn changed(a: &Audio, b: &Audio) -> bool {
    (a.volume - b.volume).abs() > 1e-3 || a.muted != b.muted || a.mic_muted != b.mic_muted
}

#[tauri::command]
pub async fn get_audio() -> Res<Audio> {
    com();
    read(&output()?, endpoint(eCapture).ok().as_ref()).map_err(err)
}

#[tauri::command]
pub async fn set_volume(volume: f32) -> Res<()> {
    com();
    unsafe { output()?.SetMasterVolumeLevelScalar(volume.clamp(0., 1.), std::ptr::null()) }.map_err(err)
}

#[tauri::command]
pub async fn set_mute(on: bool) -> Res<()> {
    com();
    unsafe { output()?.SetMute(on, std::ptr::null()) }.map_err(err)
}

#[tauri::command]
pub async fn set_mic_mute(on: bool) -> Res<()> {
    com();
    let mic = endpoint(eCapture).map_err(|_| "No microphone")?;
    unsafe { mic.SetMute(on, std::ptr::null()) }.map_err(err)
}

/// Emits "audio" (Audio) whenever the volume or a mute changes, from any app or key.
/// Polls every 250 ms on kept interfaces, re-acquired every 2 s (or after an error) so a change of
/// default device is followed; with no output device it just checks back every 2 s.
pub(crate) fn watch(app: AppHandle) {
    com();
    let (mut eps, mut got, mut last) = (None, Instant::now(), None::<Audio>);
    loop {
        if eps.is_none() || got.elapsed() >= Duration::from_secs(2) {
            eps = endpoint(eRender).ok().map(|o| (o, endpoint(eCapture).ok()));
            got = Instant::now();
        }
        match eps.as_ref().map(|(o, m)| read(o, m.as_ref())) {
            Some(Ok(a)) => {
                if last.as_ref().is_none_or(|l| changed(l, &a)) {
                    let _ = app.emit("audio", &a);
                    last = Some(a);
                }
            }
            // lost the device: announce it again when it's back, even unchanged (the Live card hid meanwhile)
            _ => (eps, last) = (None, None),
        }
        thread::sleep(Duration::from_millis(if eps.is_some() { 250 } else { 2000 }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn change_detection() {
        let a = Audio { volume: 0.5, muted: false, mic_muted: Some(false) };
        assert!(!changed(&a, &Audio { volume: 0.5004, ..a.clone() }), "float jitter isn't a change");
        assert!(changed(&a, &Audio { volume: 0.51, ..a.clone() }));
        assert!(changed(&a, &Audio { muted: true, ..a.clone() }));
        assert!(changed(&a, &Audio { mic_muted: None, ..a.clone() }), "the microphone went away");
        let json = serde_json::to_string(&a).unwrap();
        assert_eq!(json, r#"{"volume":0.5,"muted":false,"micMuted":false}"#);
    }

    /// Reads (never sets) the real default devices: `cargo test -- --ignored reads_real_devices --nocapture`.
    #[test]
    #[ignore]
    fn reads_real_devices() {
        match tauri::async_runtime::block_on(get_audio()) {
            Ok(a) => {
                println!("volume {:.2} muted {} mic {:?}", a.volume, a.muted, a.mic_muted);
                assert!((0. ..=1.).contains(&a.volume));
            }
            // a PC with nothing to play on: the only acceptable failure
            Err(e) => assert_eq!(e, "No audio output device"),
        }
        com();
        let mic = endpoint(eCapture).ok().map(|m| unsafe { m.GetMute() }.map(|b| b.as_bool()));
        println!("microphone muted: {mic:?}");
    }
}

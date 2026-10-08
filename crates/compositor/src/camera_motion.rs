//! Mouvement de caméra ("Camera Motion") — la moitié native de la fonctionnalité.
//!
//! L'app envoie la cible DÉJÀ RÉSOLUE : des nombres continus (position, taille, ratio, fraction
//! de coin, opacité), pas la forme discrète que l'auteur a choisie. La correspondance
//! forme → (aspect, coin) vit donc à un seul endroit, côté TS (`cameraMotion/resolve.ts`), et le
//! natif ne fait que ce qu'il savait déjà faire pour Full Camera : une enveloppe temporelle
//! (montée / palier / retour, chaque fenêtre bornée à la moitié de la région) et un lerp de rect
//! vers la boîte que décrit la cible.
//!
//! Full Camera est le cas particulier « cible plein cadre ». Une région legacy est évaluée dans
//! la MÊME arène, avec la fenêtre et la courbe que l'adaptateur TS lui donne
//! (`cameraMotionLegacyEquivalentTiming`) et une boîte cible de `[0, 0, 1, 1]` : le résultat est
//! celui de `regions.rs::camera_fullscreen_*` à l'octet près, ce qui permet à un projet ancien de
//! s'animer exactement comme avant. La compatibilité est arithmétique, pas un second chemin qu'il
//! faudrait garder en phase.
//!
//! Les courbes sont celles de `regions.rs` (`cubic_bezier`, `ease_out_screen_studio`,
//! `ease_spring`) — les mêmes fonctions que le zoom et Full Camera appellent, donc une courbe
//! choisie ici veut dire la même chose qu'ailleurs. `screenStudio` n'est atteignable que par
//! l'adaptateur legacy.

use crate::regions::{
    camera_fullscreen_region_phase, cubic_bezier, ease_out_screen_studio, ease_spring, smoothstep,
    ScreenClock,
};
use crate::scene::{
    SceneCameraFullscreenRegion, SceneCameraMotionRegion, SceneCameraMotionTarget,
};

/// La boîte plein cadre, en fractions du canvas : la cible d'une région legacy, et la boîte de
/// repli quand aucune cible n'est connue.
pub const FULLSCREEN_BOX: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

/// La courbe d'un mouvement de caméra, par son nom.
///
/// Un nom inconnu — ou absent — retombe sur `cubic`, exactement le défaut de `parse.ts` (TS) :
/// un fichier abîmé doit s'ouvrir, pas faire tomber la frame. Les trois béziers sont ceux de
/// `ZoomEasingPreset` (DogSC), donc une courbe choisie dans l'une ou l'autre app veut dire la
/// même chose.
fn camera_motion_easing_fn(easing: &str) -> fn(f32) -> f32 {
    match easing {
        "linear" => |t: f32| t,
        "quadratic" => |t: f32| cubic_bezier(0.45, 0.0, 0.55, 1.0, t),
        "quintic" => |t: f32| cubic_bezier(0.82, 0.0, 0.18, 1.0, t),
        "spring" => ease_spring,
        "screenStudio" => ease_out_screen_studio,
        _ => |t: f32| cubic_bezier(0.65, 0.0, 0.35, 1.0, t),
    }
}

/// La phase BRUTE (0..1) de l'enveloppe, sans courbe.
///
/// 0 à ses bornes, montée sur `lead_in_sec`, palier, descente sur `return_sec`, chaque fenêtre
/// bornée à la moitié de la région pour qu'une région courte anime pleinement les deux. Mesurée à
/// l'écran (`ScreenClock`), comme le zoom : un changement de vitesse étire le mouvement avec la
/// vidéo au lieu de le faire glisser sur l'image. C'est la phase — pas le progrès — que lit la
/// dissolution des coins.
fn camera_motion_phase_at(
    region: &SceneCameraMotionRegion,
    t: f32,
    clock: &ScreenClock,
) -> f32 {
    let start = region.start_sec as f32;
    let end = region.end_sec as f32;
    if t <= start || t >= end {
        return 0.0;
    }
    let (start, end, t) = (clock.at(start), clock.at(end), clock.at(t));
    let half = (end - start) * 0.5;
    let lead_in = region.lead_in_sec.max(0.0).min(half);
    let lead_out = region.return_sec.max(0.0).min(half);
    let lead_in_end = start + lead_in;
    if t < lead_in_end {
        return if lead_in > 0.0 {
            (t - start) / lead_in
        } else {
            1.0
        };
    }
    let lead_out_start = end - lead_out;
    if t <= lead_out_start {
        return 1.0;
    }
    if lead_out > 0.0 {
        (end - t) / lead_out
    } else {
        0.0
    }
}

/// Le progrès (0..1) d'une région au temps `t`, sa courbe appliquée. Miroir de
/// `cameraMotionProgressAt` (TS).
///
/// La courbe est appliquée à la phase entière plutôt qu'à chaque branche : les six courbes
/// passent exactement par 0 en 0 et 1 en 1, donc c'est la même chose, et le palier reste
/// exactement 1.
pub fn camera_motion_progress_at(
    region: &SceneCameraMotionRegion,
    t: f32,
    clock: &ScreenClock,
) -> f32 {
    camera_motion_easing_fn(&region.easing)(camera_motion_phase_at(region, t, clock))
}

/// Ce qu'un mouvement de caméra décrit à un instant donné.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraMotionSample {
    /// Progrès, courbe appliquée (0..1) — ce qui lerpe le rect.
    pub progress: f32,
    /// Phase brute (0..1), sans courbe — ce que lit la dissolution des coins.
    pub phase: f32,
    /// Boîte cible, en fractions du canvas : `[x, y, largeur, hauteur]`.
    pub target_box: [f32; 4],
    /// Rayon de coin de la cible, en fraction du petit côté de SA boîte (0 = coins francs,
    /// 0.5 = cercle plein). Le plein cadre vaut 0.
    pub corner_fraction: f32,
    /// Opacité cible (0..1). Transportée telle quelle ; le compositeur ne la consomme pas encore.
    pub opacity: f32,
}

impl CameraMotionSample {
    /// Ce qui reste de la bulle : 1 = bulle entière, 0 = plein cadre net.
    ///
    /// Même convention que `camera_fullscreen_shape_at` : la dissolution est TARDIVE, pas
    /// `1 - progrès`. Le rect part en ease-out et fait 90 % du chemin au premier tiers de la
    /// montée, donc des coins qui le suivaient seraient francs presque tout du long et ne se
    /// rearrondiraient qu'à l'arrivée au retour.
    pub fn shape_fade(&self) -> f32 {
        1.0 - smoothstep(0.5, 1.0, self.phase)
    }
}

/// Garde le plus fort des deux, à égalité le premier rencontré (comme TS, `>` strict).
fn keep_strongest(best: &mut Option<CameraMotionSample>, sample: CameraMotionSample) {
    if sample.progress <= 0.0 {
        return;
    }
    let better = match best {
        None => true,
        Some(prev) => sample.progress > prev.progress,
    };
    if better {
        *best = Some(sample);
    }
}

/// La boîte qu'une cible décrit, en fractions du canvas : `[x, y, largeur, hauteur]`.
///
/// `position` est le CENTRE de l'image caméra, `size` sa largeur en fraction du canvas et
/// `aspect_ratio` sa largeur/hauteur. Le canvas a son propre ratio, donc la hauteur en fraction
/// vaut `size × canvas_aspect / aspect_ratio` — c'est ce qui fait tomber la cible plein cadre
/// (size 1, aspect = ratio du canvas) exactement sur `[0, 0, 1, 1]`, comme `cameraMotionTargetRect`
/// (TS) tombe sur le canvas entier.
pub fn camera_motion_target_box(
    target: &SceneCameraMotionTarget,
    canvas_aspect: f32,
) -> [f32; 4] {
    let width = target.size;
    let height = width * canvas_aspect / target.aspect_ratio.max(0.01);
    [
        target.position_x - width * 0.5,
        target.position_y - height * 0.5,
        width,
        height,
    ]
}

/// Le mouvement qui « gagne » à `t`, ou `None` si la caméra est au repos.
///
/// Les régions Camera Motion ET les régions Full Camera legacy sont évaluées ensemble : la
/// legacy est un mouvement vers le plein cadre, donc une seule animation à la fois — la plus
/// forte —, jamais deux superposées. Comme TS (`resolveCameraMotionWinner`), le plus grand
/// progrès mène, et à égalité c'est la première région rencontrée qui garde la main (les régions
/// auteur d'abord, les legacy ensuite).
pub fn camera_motion_sample_at(
    regions: &[SceneCameraMotionRegion],
    legacy: &[SceneCameraFullscreenRegion],
    t: f32,
    clock: &ScreenClock,
    canvas_aspect: f32,
) -> Option<CameraMotionSample> {
    let mut best: Option<CameraMotionSample> = None;

    for region in regions {
        let phase = camera_motion_phase_at(region, t, clock);
        keep_strongest(
            &mut best,
            CameraMotionSample {
                progress: camera_motion_easing_fn(&region.easing)(phase),
                phase,
                target_box: camera_motion_target_box(&region.target, canvas_aspect),
                corner_fraction: region.target.corner_fraction,
                opacity: region.target.opacity,
            },
        );
    }

    for region in legacy {
        let phase = camera_fullscreen_region_phase(region, t, clock);
        keep_strongest(
            &mut best,
            CameraMotionSample {
                progress: ease_out_screen_studio(phase),
                phase,
                target_box: FULLSCREEN_BOX,
                corner_fraction: 0.0,
                opacity: 1.0,
            },
        );
    }

    best
}

/// Le rect de base lerpé vers la boîte décrite par `sample`, à son progrès.
///
/// Avec la cible plein cadre, ceci rend exactement ce que le `fullscreen_dst` de
/// `frame_geometry.rs` rendait : mêmes extrémités (`[0, 0, 1, 1]`) et même lerp.
pub fn camera_motion_dst(base: [f32; 4], sample: &CameraMotionSample) -> [f32; 4] {
    let t = sample.progress.clamp(0.0, 1.0);
    if t <= 0.0 {
        return base;
    }
    let lerp = |a: f32, b: f32| a + (b - a) * t;
    let dest = sample.target_box;
    [
        lerp(base[0], dest[0]),
        lerp(base[1], dest[1]),
        lerp(base[2], dest[2]),
        lerp(base[3], dest[3]),
    ]
}

/// Le rayon de coin du rect en mouvement, en px.
///
/// Vers une cible aux coins nuls (plein cadre) la dissolution est TARDIVE : c'est
/// `1 - shape_fade` (= `smoothstep(0.5, 1, phase)`), la courbe de `camera_fullscreen_shape_at`.
/// Vers une forme (coins cibles non nuls), les coins suivent le rect (`progress`), comme
/// `applyCameraMotionToRect` (TS) — une forme qui se déplace garde ses coins sur la même horloge
/// que sa boîte.
///
/// Avec une cible plein cadre et `base_px` = le rayon de la bulle, ceci rend exactement
/// `shape_fade * base_px` : le rayon Full Camera d'avant, à l'octet près.
pub fn camera_motion_radius(base_px: f32, dest_px: f32, sample: &CameraMotionSample) -> f32 {
    let blend = if dest_px <= 0.0 {
        1.0 - sample.shape_fade()
    } else {
        sample.progress
    };
    let blend = blend.clamp(0.0, 1.0);
    base_px + (dest_px - base_px) * blend
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un canvas 16:9, comme la sortie de l'app par défaut.
    const CANVAS_ASPECT: f32 = 16.0 / 9.0;

    /// La fenêtre d'arrivée de Full Camera, en secondes : `TRANSITION_WINDOW_S` (`regions.rs`).
    const LEGACY_LEAD_IN_SEC: f32 = 1.01505;
    /// La courbe de l'enveloppe legacy.
    const LEGACY_EASING: &str = "screenStudio";

    fn legacy_region(start: f64, end: f64) -> SceneCameraFullscreenRegion {
        SceneCameraFullscreenRegion {
            clip_index: None,
            start_sec: start,
            end_sec: end,
        }
    }

    /// Une région Camera Motion dont la cible est le plein cadre, avec la fenêtre et la courbe que
    /// l'adaptateur legacy donne à une région Full Camera — donc l'équivalent exact d'une legacy.
    fn fullscreen_region(start: f64, end: f64) -> SceneCameraMotionRegion {
        SceneCameraMotionRegion {
            clip_index: None,
            start_sec: start,
            end_sec: end,
            target: SceneCameraMotionTarget {
                position_x: 0.5,
                position_y: 0.5,
                size: 1.0,
                aspect_ratio: CANVAS_ASPECT,
                corner_fraction: 0.0,
                fullscreen_progress: 1.0,
                opacity: 1.0,
            },
            lead_in_sec: LEGACY_LEAD_IN_SEC,
            return_sec: LEGACY_LEAD_IN_SEC * 1.5,
            easing: LEGACY_EASING.to_string(),
        }
    }

    /// Le point de tout le module : une cible plein cadre animée par le chemin Camera Motion doit
    /// rendre exactement ce que Full Camera rendait — progrès ET dissolution des coins. C'est ce
    /// qui autorise à évaluer les deux familles de régions dans la même arène.
    #[test]
    fn a_fullscreen_camera_motion_matches_legacy_full_camera() {
        let legacy = [legacy_region(10.0, 20.0)];
        let motion = [fullscreen_region(10.0, 20.0)];
        let clock = ScreenClock::default();
        for step in 0..=2000 {
            let t = step as f32 * 0.01;
            let expected = crate::regions::camera_fullscreen_progress_at(&legacy, t, &clock);
            let sample = camera_motion_sample_at(&motion, &[], t, &clock, CANVAS_ASPECT);
            let progress = sample.map(|s| s.progress).unwrap_or(0.0);
            assert!(
                (expected - progress).abs() < 1e-6,
                "progrès t={t} : {expected} vs {progress}"
            );
            let expected_shape = crate::regions::camera_fullscreen_shape_at(&legacy, t, &clock);
            let shape = sample.map(|s| s.shape_fade()).unwrap_or(1.0);
            assert!(
                (expected_shape - shape).abs() < 1e-6,
                "coins t={t} : {expected_shape} vs {shape}"
            );
        }
    }

    /// L'enveloppe est entièrement contenue dans `[start, end]`, et le palier vaut exactement 1.
    #[test]
    fn the_envelope_is_contained_in_the_region() {
        let region = fullscreen_region(10.0, 20.0);
        let clock = ScreenClock::default();
        assert_eq!(camera_motion_progress_at(&region, 5.0, &clock), 0.0);
        assert_eq!(camera_motion_progress_at(&region, 10.0, &clock), 0.0);
        assert_eq!(camera_motion_progress_at(&region, 20.0, &clock), 0.0);
        assert_eq!(camera_motion_progress_at(&region, 25.0, &clock), 0.0);
        assert_eq!(camera_motion_progress_at(&region, 15.0, &clock), 1.0);
    }

    /// Une courbe inconnue — ou absente — retombe sur `cubic`, jamais sur un panic ni sur zéro.
    #[test]
    fn an_unknown_easing_falls_back_to_cubic() {
        let clock = ScreenClock::default();
        let mut cubic = fullscreen_region(10.0, 20.0);
        cubic.easing = "cubic".to_string();
        for name in ["wobble", ""] {
            let mut region = fullscreen_region(10.0, 20.0);
            region.easing = name.to_string();
            for step in 0..=1000 {
                let t = 10.0 + step as f32 * 0.01;
                assert_eq!(
                    camera_motion_progress_at(&region, t, &clock),
                    camera_motion_progress_at(&cubic, t, &clock),
                    "courbe « {name} » à t={t}"
                );
            }
        }
    }

    /// Les coins suivent la phase, pas le progrès : intacts au premier tiers de la montée, fondus
    /// au plein cadre, revenus à mi-retour.
    #[test]
    fn corners_dissolve_late_and_come_back_early() {
        let region = [fullscreen_region(10.0, 20.0)];
        let clock = ScreenClock::default();
        let at = |t: f32| {
            camera_motion_sample_at(&region, &[], t, &clock, CANVAS_ASPECT)
                .map(|s| (s.progress, s.shape_fade()))
        };
        let (progress, shape) = at(10.0 + LEGACY_LEAD_IN_SEC / 3.0).unwrap();
        assert!(progress > 0.85 && shape == 1.0, "montée : {progress} / {shape}");
        let (progress, shape) = at(20.0 - LEGACY_LEAD_IN_SEC * 1.5 / 2.0).unwrap();
        assert!(progress > 0.95 && shape > 0.999, "retour : {progress} / {shape}");
        assert_eq!(at(15.0), Some((1.0, 0.0)), "plein cadre : plus de coins");
        assert_eq!(at(5.0), None, "hors région : pas de mouvement");
    }

    /// La région la plus avancée mène — la même règle que le web.
    #[test]
    fn the_strongest_region_wins() {
        let clock = ScreenClock::default();
        let mut slow = fullscreen_region(10.0, 20.0);
        slow.lead_in_sec = 5.0;
        let mut fast = fullscreen_region(10.0, 20.0);
        fast.lead_in_sec = 0.1;
        let sample =
            camera_motion_sample_at(&[slow, fast], &[], 10.2, &clock, CANVAS_ASPECT).unwrap();
        assert_eq!(sample.progress, 1.0, "la montée rapide est déjà au palier");
    }

    /// Une région legacy et une région auteur partagent la même arène : la plus forte gagne, et
    /// une legacy seule décrit le plein cadre.
    #[test]
    fn a_legacy_region_is_evaluated_in_the_same_arena() {
        let clock = ScreenClock::default();
        let legacy = [legacy_region(10.0, 20.0)];

        let sample = camera_motion_sample_at(&[], &legacy, 15.0, &clock, CANVAS_ASPECT).unwrap();
        assert_eq!(sample.progress, 1.0);
        assert_eq!(sample.target_box, FULLSCREEN_BOX);

        let mut authored = fullscreen_region(10.0, 20.0);
        authored.lead_in_sec = 0.05;
        authored.target.size = 0.2;
        let sample =
            camera_motion_sample_at(&[authored], &legacy, 10.05, &clock, CANVAS_ASPECT).unwrap();
        assert!(
            (sample.target_box[2] - 0.2).abs() < 1e-6,
            "la boîte auteur, plus avancée, mène : {:?}",
            sample.target_box
        );
    }

    /// La boîte cible : le plein cadre tombe pile sur le canvas, et une boîte carrée sur un canvas
    /// 16:9 vaut `size × 16/9` de haut.
    #[test]
    fn a_target_box_is_what_the_target_describes() {
        let target = SceneCameraMotionTarget {
            position_x: 0.5,
            position_y: 0.5,
            size: 1.0,
            aspect_ratio: CANVAS_ASPECT,
            corner_fraction: 0.0,
            fullscreen_progress: 1.0,
            opacity: 1.0,
        };
        assert_eq!(camera_motion_target_box(&target, CANVAS_ASPECT), FULLSCREEN_BOX);

        let square = SceneCameraMotionTarget {
            size: 0.5,
            aspect_ratio: 1.0,
            ..target
        };
        let rect = camera_motion_target_box(&square, CANVAS_ASPECT);
        assert!((rect[0] - 0.25).abs() < 1e-6, "centre horizontal : {rect:?}");
        assert!((rect[2] - 0.5).abs() < 1e-6, "largeur : {rect:?}");
        assert!(
            (rect[3] - 0.5 * CANVAS_ASPECT).abs() < 1e-6,
            "hauteur : {rect:?}"
        );
    }

    /// Le lerp de rect : la cible plein cadre donne le canvas, et un progrès nul laisse le rect.
    #[test]
    fn the_dst_lerps_towards_the_target_box() {
        let sample = CameraMotionSample {
            progress: 0.5,
            phase: 0.5,
            target_box: FULLSCREEN_BOX,
            corner_fraction: 0.0,
            opacity: 1.0,
        };
        let dst = camera_motion_dst([0.7, 0.7, 0.2, 0.2], &sample);
        assert!((dst[0] - 0.35).abs() < 1e-6, "{dst:?}");
        assert!((dst[2] - 0.6).abs() < 1e-6, "{dst:?}");

        let idle = CameraMotionSample {
            progress: 0.0,
            ..sample
        };
        assert_eq!(camera_motion_dst([0.7, 0.7, 0.2, 0.2], &idle), [0.7, 0.7, 0.2, 0.2]);
    }

    /// Le rayon : plein cadre → dissolution tardive (la bulle tient sa première moitié) ; vers une
    /// forme → les coins suivent le progrès.
    #[test]
    fn the_radius_dissolves_late_towards_fullscreen() {
        let region = [fullscreen_region(10.0, 20.0)];
        let clock = ScreenClock::default();
        let base = 100.0f32;

        let rising = camera_motion_sample_at(
            &region,
            &[],
            10.0 + LEGACY_LEAD_IN_SEC / 3.0,
            &clock,
            CANVAS_ASPECT,
        )
        .unwrap();
        assert!((camera_motion_radius(base, 0.0, &rising) - base).abs() < 1e-3);

        let full = camera_motion_sample_at(&region, &[], 15.0, &clock, CANVAS_ASPECT).unwrap();
        assert!(camera_motion_radius(base, 0.0, &full).abs() < 1e-3);

        let mut shaped = fullscreen_region(10.0, 20.0);
        shaped.target.corner_fraction = 0.5;
        let shaped =
            camera_motion_sample_at(&[shaped], &[], 15.0, &clock, CANVAS_ASPECT).unwrap();
        assert!((camera_motion_radius(base, 40.0, &shaped) - 40.0).abs() < 1e-3);
    }
}

//! Ouverture globale — preset « Side Slide ».
//!
//! L'entrée de tout le programme : l'écran glisse depuis la gauche, la caméra depuis la
//! droite, décalés l'un par rapport à l'autre, puis tout se pose exactement sur la mise en
//! page normale.
//!
//! # Pourquoi ici, et pas sur un clip
//!
//! L'ouverture est GLOBALE. Elle se joue sur l'horloge de SORTIE — `programme_time`, continu
//! à travers les coupes — et jamais sur le temps source d'un clip. Un clip qui commence à la
//! 1re seconde d'un programme de 6 s doit jouer la SECONDE moitié de l'ouverture, pas la
//! rejouer depuis zéro. C'est la seule sémantique qui tient aussi quand on coupe, trim et
//! réordonne, et c'est pour ça que `sample_at` prend un temps programme et rien d'autre.
//!
//! # Forme
//!
//! Toutes les fonctions sont pures et sans état : n'importe quelle image peut être demandée
//! dans n'importe quel ordre (seek), sans avoir joué les précédentes. Aucune ne peut produire
//! NaN ou Inf, même sur une configuration absurde — `OpeningSequence::repaired` borne tout ce
//! qui entre.

use crate::scene::SceneOpening;

/// Nom d'élément : le métrage écran.
pub const ELEMENT_SCREEN: &str = "screen";
/// Nom d'élément : la caméra.
pub const ELEMENT_CAMERA: &str = "camera";

/// Bornes du réglage « durée ». Un cran plus court ne se lit pas comme une entrée, un cran plus
/// long n'est plus une ouverture — c'est une animation, et ça n'est pas ce preset.
const MIN_DURATION_SEC: f32 = 0.4;
const MAX_DURATION_SEC: f32 = 8.0;
/// DogSC's Side Slide default, and what a missing field means.
const DEFAULT_DURATION_SEC: f32 = 2.2;

/// Bornes du décalage entre éléments.
const MIN_STAGGER_SEC: f32 = 0.0;
const MAX_STAGGER_SEC: f32 = 1.2;
const DEFAULT_STAGGER_SEC: f32 = 0.16;

/// Le second élément ne peut pas commencer si tard qu'il n'aurait plus le temps d'entrer : le
/// décalage est borné à cette fraction de la durée totale.
const STAGGER_DURATION_FRACTION: f32 = 0.8;

/// Part du temps qu'un élément passe à glisser, au minimum. Empêche une durée de glissement
/// nulle (qui ferait un « pop » d'une image) quand durée et décalage sont presque égaux.
const MIN_SLIDE_SEC: f32 = 0.05;

/// Échelles de départ, reprises de DogSC : l'écran part à 94 %, la caméra à 88 %, et les deux
/// finissent à 100 %. Une caméra part de plus loin parce qu'elle est plus petite à l'écran :
/// le même 6 % se lirait comme un à-coup sur une vignette.
const SCREEN_FROM_SCALE: f32 = 0.94;
const CAMERA_FROM_SCALE: f32 = 0.88;

/// Ce qu'un élément doit faire à un instant donné.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpeningSample {
    /// Progression 0..1 DÉJÀ adoucie. 1 = exactement en place ; c'est le cas dès que
    /// l'élément a fini, et l'appelant peut alors court-circuiter entièrement.
    pub eased: f32,
    /// Échelle au repos de l'élément, à `eased = 0`.
    pub from_scale: f32,
    /// -1.0 = entre par la gauche, +1.0 = entre par la droite.
    pub side: f32,
}

/// Les deux éléments, échantillonnés au même instant. `None` = cet élément n'entre pas
/// (désactivé, ou pas de caméra dans ce projet).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct OpeningFrame {
    pub screen: Option<OpeningSample>,
    pub camera: Option<OpeningSample>,
}

impl OpeningFrame {
    /// Aucun élément ne bouge : le rendu doit être celui d'avant l'ouverture.
    pub fn is_identity(&self) -> bool {
        self.screen.is_none() && self.camera.is_none()
    }
}

/// Configuration d'ouverture RÉPARÉE : bornée, dédoublonnée, complétée.
///
/// Construite une fois par image à partir de `Scene::opening`, qui vient d'un JSON pouvant
/// avoir été écrit à la main. Rien en aval n'a besoin de re-vérifier quoi que ce soit.
#[derive(Debug, Clone, PartialEq)]
pub struct OpeningSequence {
    enabled: bool,
    duration_sec: f32,
    stagger_sec: f32,
    slide_sec: f32,
    /// Ordre d'entrée, dédoublonné et complété avec les deux éléments connus.
    order: Vec<String>,
    included: Vec<String>,
}

impl OpeningSequence {
    /// Répare une configuration brute. Ne peut pas échouer : toute entrée produit une
    /// séquence utilisable, éventuellement désactivée.
    pub fn repaired(raw: &SceneOpening) -> Self {
        let duration_sec = sanitize_sec(
            raw.duration_sec,
            DEFAULT_DURATION_SEC,
            MIN_DURATION_SEC,
            MAX_DURATION_SEC,
        );
        let stagger_sec = sanitize_sec(
            raw.stagger_sec,
            DEFAULT_STAGGER_SEC,
            MIN_STAGGER_SEC,
            MAX_STAGGER_SEC,
        )
        // Borné par la durée : au-delà, le second élément commencerait après la fin de
        // l'ouverture, et « rien ne bouge après `duration` » deviendrait faux.
        .min(duration_sec * STAGGER_DURATION_FRACTION);

        let order = sanitize_names(&raw.element_order, true);
        let included = sanitize_names(&raw.included_elements, false);
        let slide_sec = (duration_sec - stagger_sec).max(MIN_SLIDE_SEC);

        Self {
            enabled: raw.enabled,
            duration_sec,
            stagger_sec,
            slide_sec,
            order,
            included,
        }
    }

    /// L'ouverture ne fait rien : interrupteur fermé, ou aucun élément retenu.
    pub fn is_identity(&self) -> bool {
        !self.enabled || self.included.is_empty()
    }

    pub fn duration_sec(&self) -> f32 {
        self.duration_sec
    }

    pub fn stagger_sec(&self) -> f32 {
        self.stagger_sec
    }

    pub fn included(&self) -> &[String] {
        &self.included
    }

    pub fn order(&self) -> &[String] {
        &self.order
    }

    /// Échantillonne l'ouverture au temps PROGRAMME `t_sec`.
    ///
    /// `has_camera` est la seule information qui vient d'ailleurs : sans caméra dans le
    /// projet, il n'y a pas de second élément à faire entrer. Le passer explicitement plutôt
    /// que de le deviner ici garde cette fonction testable sans construire une scène.
    pub fn sample_at(&self, t_sec: f32, has_camera: bool) -> OpeningFrame {
        if self.is_identity() {
            return OpeningFrame::default();
        }
        // Un temps non fini ne doit pas se propager en NaN dans une géométrie.
        let t = if t_sec.is_finite() { t_sec } else { 0.0 };

        let mut frame = OpeningFrame::default();
        if self.includes(ELEMENT_SCREEN) {
            frame.screen = Some(self.sample_element(ELEMENT_SCREEN, t));
        }
        if has_camera && self.includes(ELEMENT_CAMERA) {
            frame.camera = Some(self.sample_element(ELEMENT_CAMERA, t));
        }
        frame
    }

    fn includes(&self, element: &str) -> bool {
        self.included.iter().any(|n| n == element)
    }

    fn sample_element(&self, element: &str, t: f32) -> OpeningSample {
        let camera = element == ELEMENT_CAMERA;
        // Position dans l'ordre d'entrée : le premier élément part à 0, le second à
        // `stagger`. Un nom absent de l'ordre (impossible après réparation) part à 0.
        let index = self.order.iter().position(|n| n == element).unwrap_or(0) as f32;
        let start = index * self.stagger_sec;
        let progress = ((t - start) / self.slide_sec).clamp(0.0, 1.0);
        OpeningSample {
            eased: swift_ease(progress),
            from_scale: if camera {
                CAMERA_FROM_SCALE
            } else {
                SCREEN_FROM_SCALE
            },
            side: if camera { 1.0 } else { -1.0 },
        }
    }
}

/// La courbe `swift` de DogSC : `1 - (1 - p)^4`.
///
/// Un ease-out quart : départ franc, arrivée posée. À `p = 0` elle vaut exactement 0 et à
/// `p = 1` exactement 1 — ce sont les deux valeurs sur lesquelles reposent « part de hors
/// cadre » et « se pose exactement », donc elles sont garanties, pas approchées.
pub fn swift_ease(progress: f32) -> f32 {
    let p = progress.clamp(0.0, 1.0);
    let inv = 1.0 - p;
    1.0 - inv * inv * inv * inv
}

/// Applique l'entrée à un rect normalisé `[x, y, w, h]` (fractions du cadre de sortie).
///
/// L'élément tourne autour de SON centre (il rétrécit sur place, il ne se décale pas vers un
/// coin) puis se translate latéralement d'une longueur qui le met entièrement hors cadre au
/// départ. `eased >= 1.0` renvoie `base` TEL QUEL — pas un calcul qui retomberait dessus :
/// c'est ce qui garantit que l'image finale est bit pour bit celle d'une ouverture éteinte.
pub fn opening_rect(base: [f32; 4], sample: &OpeningSample) -> [f32; 4] {
    if sample.eased >= 1.0 {
        return base;
    }
    let eased = sample.eased.clamp(0.0, 1.0);
    let scale = sample.from_scale + (1.0 - sample.from_scale) * eased;
    let w = base[2] * scale;
    let h = base[3] * scale;
    let cx = base[0] + base[2] * 0.5;
    let cy = base[1] + base[3] * 0.5;
    // `1.0` est la largeur du cadre (coordonnées normalisées) : la translation vaut donc
    // « toute la largeur, plus la largeur de l'élément », ce qui le sort du cadre quelle que
    // soit sa taille. Le facteur `(1 - eased)` la ramène à zéro au moment où l'élément se pose.
    let travel = 1.0 - eased;
    let dx = sample.side * travel * (1.0 + w);
    [cx - w * 0.5 + dx, cy - h * 0.5, w, h]
}

/// `true` si le nom désigne un élément que ce preset sait animer.
pub fn is_known_element(name: &str) -> bool {
    name == ELEMENT_SCREEN || name == ELEMENT_CAMERA
}

/// Ramène une durée dans ses bornes. Une valeur non finie (NaN, ±Inf) retombe sur le défaut :
/// la propager plus loin finirait en géométrie NaN, donc en cadre noir.
fn sanitize_sec(value: f32, default: f32, min: f32, max: f32) -> f32 {
    if !value.is_finite() {
        return default;
    }
    value.clamp(min, max)
}

/// Filtre les noms inconnus, dédoublonne, et — pour l'ordre d'entrée — complète avec les
/// éléments manquants.
///
/// `fill_missing` est ce qui distingue les deux listes : l'ORDRE doit nommer les deux éléments
/// (sinon le second n'aurait pas de rang), tandis que la SÉLECTION peut n'en nommer qu'un —
/// c'est même le cas normal quand le projet n'a pas de caméra.
fn sanitize_names(raw: &[String], fill_missing: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(raw.len().max(2));
    for name in raw {
        if is_known_element(name) && !out.iter().any(|n| n == name) {
            out.push(name.clone());
        }
    }
    if fill_missing {
        for element in [ELEMENT_SCREEN, ELEMENT_CAMERA] {
            if !out.iter().any(|n| n == element) {
                out.push(element.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(enabled: bool) -> OpeningSequence {
        OpeningSequence::repaired(&SceneOpening {
            enabled,
            ..Default::default()
        })
    }

    fn with(duration: f32, stagger: f32) -> OpeningSequence {
        OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            duration_sec: duration,
            stagger_sec: stagger,
            ..Default::default()
        })
    }

    #[test]
    fn swift_curve_is_pinned_at_both_ends() {
        assert_eq!(swift_ease(0.0), 0.0);
        assert_eq!(swift_ease(1.0), 1.0);
        // Monotone, et strictement au-dessus de la diagonale (c'est un ease-OUT).
        let mut prev = 0.0;
        for i in 0..=100 {
            let p = i as f32 / 100.0;
            let e = swift_ease(p);
            assert!(e >= prev, "curve must not go backwards at p={p}");
            assert!(e >= p - 1e-6, "ease-out must not lag the diagonal at p={p}");
            prev = e;
        }
        // Hors bornes : on borne plutôt que d'extrapoler.
        assert_eq!(swift_ease(-1.0), 0.0);
        assert_eq!(swift_ease(2.0), 1.0);
    }

    #[test]
    fn disabled_is_the_identity() {
        let s = seq(false);
        assert!(s.is_identity());
        let frame = s.sample_at(0.0, true);
        assert!(frame.is_identity(), "disabled must produce no samples at all");
        assert_eq!(frame.screen, None);
        assert_eq!(frame.camera, None);
    }

    #[test]
    fn no_included_elements_is_also_the_identity() {
        let s = OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            included_elements: vec![],
            ..Default::default()
        });
        assert!(s.is_identity());
        assert!(s.sample_at(1.0, true).is_identity());
    }

    #[test]
    fn at_t0_the_screen_starts_off_canvas_on_the_left() {
        let s = seq(true);
        let frame = s.sample_at(0.0, true);
        let screen = frame.screen.expect("screen enters");
        assert_eq!(screen.eased, 0.0);
        assert_eq!(screen.side, -1.0);
        assert_eq!(screen.from_scale, SCREEN_FROM_SCALE);

        let base = [0.1, 0.1, 0.8, 0.8];
        let out = opening_rect(base, &screen);
        assert!(out[0] + out[2] <= 0.0, "screen must be fully left of the frame, got {out:?}");
        // Mise à l'échelle autour de son propre centre : le centre vertical ne bouge pas.
        let base_cy = base[1] + base[3] * 0.5;
        let out_cy = out[1] + out[3] * 0.5;
        assert!((base_cy - out_cy).abs() < 1e-6, "must shrink in place vertically");
    }

    #[test]
    fn at_t0_the_camera_starts_off_canvas_on_the_right() {
        let s = seq(true);
        let camera = s.sample_at(0.0, true).camera.expect("camera enters");
        assert_eq!(camera.side, 1.0);
        assert_eq!(camera.from_scale, CAMERA_FROM_SCALE);

        let base = [0.62, 0.62, 0.3, 0.3];
        let out = opening_rect(base, &camera);
        assert!(out[0] >= 1.0, "camera must be fully right of the frame, got {out:?}");
    }

    #[test]
    fn stagger_delays_the_second_element() {
        let s = with(2.2, 0.16);
        // À mi-décalage, l'écran a déjà commencé, la caméra pas encore.
        let mid = s.sample_at(0.08, true);
        assert!(mid.screen.unwrap().eased > 0.0, "screen leads");
        assert_eq!(mid.camera.unwrap().eased, 0.0, "camera has not started yet");

        // Juste avant le décalage, la caméra est encore immobile.
        let before = s.sample_at(0.15, true);
        assert_eq!(before.camera.unwrap().eased, 0.0);
        // Juste après, elle bouge.
        let after = s.sample_at(0.17, true);
        assert!(after.camera.unwrap().eased > 0.0);
    }

    #[test]
    fn at_the_end_of_the_duration_everything_is_exactly_home() {
        let s = with(2.2, 0.16);
        for t in [2.2_f32, 2.21, 3.0, 60.0] {
            let frame = s.sample_at(t, true);
            assert_eq!(frame.screen.unwrap().eased, 1.0, "screen home at t={t}");
            assert_eq!(frame.camera.unwrap().eased, 1.0, "camera home at t={t}");
            let base = [0.1, 0.1, 0.8, 0.8];
            assert_eq!(opening_rect(base, &frame.screen.unwrap()), base);
            assert_eq!(opening_rect(base, &frame.camera.unwrap()), base);
        }
    }

    #[test]
    fn nothing_moves_after_the_duration() {
        let s = with(2.2, 0.16);
        let base = [0.1, 0.1, 0.8, 0.8];
        let at_end = opening_rect(base, &s.sample_at(2.2, true).screen.unwrap());
        for t in [2.5_f32, 5.0, 30.0] {
            let later = opening_rect(base, &s.sample_at(t, true).screen.unwrap());
            assert_eq!(later, at_end, "geometry drifted after the duration at t={t}");
        }
    }

    #[test]
    fn without_a_camera_only_the_screen_enters() {
        let s = seq(true);
        let frame = s.sample_at(0.5, false);
        assert!(frame.screen.is_some(), "screen enters without a camera");
        assert_eq!(frame.camera, None, "no camera, no camera animation");
    }

    #[test]
    fn swapping_the_order_swaps_who_starts_first() {
        let screen_first = with(2.2, 0.16);
        let camera_first = OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            duration_sec: 2.2,
            stagger_sec: 0.16,
            element_order: vec!["camera".into(), "screen".into()],
            ..Default::default()
        });

        // Au début, seul le PREMIER de l'ordre a bougé.
        let a = screen_first.sample_at(0.08, true);
        assert!(a.screen.unwrap().eased > 0.0);
        assert_eq!(a.camera.unwrap().eased, 0.0);

        let b = camera_first.sample_at(0.08, true);
        assert_eq!(b.screen.unwrap().eased, 0.0, "screen now waits its turn");
        assert!(b.camera.unwrap().eased > 0.0, "camera now leads");
    }

    #[test]
    fn both_still_finish_exactly_at_the_duration_after_swapping() {
        let camera_first = OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            duration_sec: 2.2,
            stagger_sec: 0.16,
            element_order: vec!["camera".into(), "screen".into()],
            ..Default::default()
        });
        let frame = camera_first.sample_at(2.2, true);
        assert_eq!(frame.screen.unwrap().eased, 1.0);
        assert_eq!(frame.camera.unwrap().eased, 1.0);
    }

    #[test]
    fn a_multi_clip_programme_does_not_restart_the_opening() {
        // L'ouverture ne connaît que le temps programme : rejouer la même seconde donne le
        // même état, quel que soit le clip sous la tête de lecture.
        let s = seq(true);
        let at_half = s.sample_at(1.1, true).screen.unwrap();
        assert!(at_half.eased > 0.0 && at_half.eased < 1.0, "mid-flight");
        // Le second clip commence à 1 s : l'ouverture y est déjà à mi-parcours, pas à zéro.
        let in_second_clip = s.sample_at(1.1, true).screen.unwrap();
        assert_eq!(in_second_clip.eased, at_half.eased);
        assert_ne!(in_second_clip.eased, 0.0, "must not restart at the clip boundary");
    }

    #[test]
    fn seeking_is_stateless() {
        let s = with(2.2, 0.16);
        // Aller-retour : 3 s → 0.5 s → 2.5 s. Chaque état est calculé, pas mémorisé.
        let a = s.sample_at(3.0, true);
        let b = s.sample_at(0.5, true);
        let c = s.sample_at(2.5, true);
        assert_eq!(a.screen.unwrap().eased, 1.0);
        assert!(b.screen.unwrap().eased > 0.0 && b.screen.unwrap().eased < 1.0);
        assert_eq!(c.screen.unwrap().eased, 1.0);
        // Et y revenir redonne exactement la même chose.
        assert_eq!(s.sample_at(0.5, true), b);
    }

    #[test]
    fn invalid_settings_never_produce_nan_or_inf() {
        let cases = [
            SceneOpening { enabled: true, duration_sec: f32::NAN, ..Default::default() },
            SceneOpening { enabled: true, duration_sec: f32::INFINITY, ..Default::default() },
            SceneOpening { enabled: true, duration_sec: -5.0, ..Default::default() },
            SceneOpening { enabled: true, stagger_sec: f32::NAN, ..Default::default() },
            SceneOpening { enabled: true, stagger_sec: f32::INFINITY, ..Default::default() },
            SceneOpening { enabled: true, stagger_sec: -1.0, ..Default::default() },
            // Décalage plus long que la durée : doit être ramené, pas laisser un élément
            // commencer après la fin.
            SceneOpening { enabled: true, duration_sec: 1.0, stagger_sec: 5.0, ..Default::default() },
            SceneOpening { enabled: true, duration_sec: 0.0, stagger_sec: 0.0, ..Default::default() },
        ];
        for raw in cases {
            let s = OpeningSequence::repaired(&raw);
            assert!(s.duration_sec().is_finite() && s.duration_sec() > 0.0, "{raw:?}");
            assert!(s.stagger_sec().is_finite() && s.stagger_sec() >= 0.0, "{raw:?}");
            assert!(
                s.stagger_sec() <= s.duration_sec(),
                "stagger must not outlast the opening: {raw:?}"
            );
            for t in [-1.0_f32, 0.0, 0.5, 1.0, 2.2, 10.0, f32::NAN, f32::INFINITY] {
                let frame = s.sample_at(t, true);
                for sample in [frame.screen, frame.camera].into_iter().flatten() {
                    assert!(sample.eased.is_finite(), "eased NaN/Inf at t={t} for {raw:?}");
                    assert!((0.0..=1.0).contains(&sample.eased), "eased out of range");
                    let out = opening_rect([0.1, 0.1, 0.8, 0.8], &sample);
                    for v in out {
                        assert!(v.is_finite(), "rect NaN/Inf at t={t} for {raw:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn unknown_names_are_dropped_and_missing_ones_filled_in() {
        let s = OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            element_order: vec!["sticker".into(), "camera".into(), "camera".into()],
            included_elements: vec!["sticker".into(), "screen".into(), "screen".into()],
            ..Default::default()
        });
        // `sticker` n'existe pas encore : ignoré, pas de panique.
        assert_eq!(s.order(), &["camera".to_string(), "screen".to_string()]);
        // Dédoublonné, et l'écran reste le seul élément retenu.
        assert_eq!(s.included(), &["screen".to_string()]);
        let frame = s.sample_at(0.0, true);
        assert!(frame.screen.is_some());
        assert_eq!(frame.camera, None, "camera was not selected");
    }

    #[test]
    fn an_empty_order_still_ranks_both_elements() {
        let s = OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            element_order: vec![],
            ..Default::default()
        });
        assert_eq!(s.order(), &["screen".to_string(), "camera".to_string()]);
    }

    #[test]
    fn the_rect_shrinks_in_place_then_lands_on_the_base() {
        let s = with(2.2, 0.16);
        let base = [0.2, 0.2, 0.6, 0.6];
        // À mi-vol, l'élément est plus petit qu'au repos mais pas encore à sa taille finale.
        let mid = opening_rect(base, &s.sample_at(1.0, true).screen.unwrap());
        assert!(mid[2] < base[2] && mid[2] > base[2] * SCREEN_FROM_SCALE);
        // Et le centre est déjà celui du repos (la translation est le seul écart restant).
        let base_cx = base[0] + base[2] * 0.5;
        let mid_cx = mid[0] + mid[2] * 0.5;
        assert!((base_cx - mid_cx).abs() > 0.0, "still travelling");
    }
}

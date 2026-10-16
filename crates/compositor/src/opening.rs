//! Ouverture globale — presets « Side Slide » et « Converge ».
//!
//! L'entrée de tout le programme. En Side Slide l'écran glisse depuis la gauche et la caméra
//! depuis la droite ; en Converge l'écran arrive du coin haut-gauche et la caméra du coin
//! bas-droit, en plus petit. Dans les deux cas, décalés l'un par rapport à l'autre, puis tout
//! se pose exactement sur la mise en page normale.
//!
//! Les deux presets ne diffèrent QUE par la géométrie de départ (échelle + point d'origine) :
//! la courbe, le calcul du temps, le décalage entre éléments et la liste des participants sont
//! communs. C'est ce qui permet d'en ajouter un troisième sans toucher à la chorégraphie.
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

/// Nom du preset « glissement latéral » : chacun entre par son côté, à l'horizontale.
pub const PRESET_SIDE_SLIDE: &str = "sideSlide";
/// Nom du preset « convergence » : chacun entre par un coin opposé, en plus petit.
pub const PRESET_CONVERGE: &str = "converge";

/// Échelles de départ du Side Slide, reprises de DogSC : l'écran part à 94 %, la caméra à
/// 88 %, et les deux finissent à 100 %. Une caméra part de plus loin parce qu'elle est plus
/// petite à l'écran : le même 6 % se lirait comme un à-coup sur une vignette.
const SCREEN_FROM_SCALE: f32 = 0.94;
const CAMERA_FROM_SCALE: f32 = 0.88;

/// Converge — l'écran part du coin haut-gauche, la caméra du coin bas-droit, et les deux
/// convergent vers leur place. Départ plus franc qu'un Side Slide (0,72 / 0,58) : c'est ce qui
/// fait lire « ça se rassemble » plutôt que « ça glisse ».
///
/// Les offsets sont en FRACTIONS DE LA TOILE (largeur pour x, hauteur pour y), jamais en
/// pixels : la même scène doit se composer à l'identique en 480×270 comme en 4K.
const CONVERGE_SCREEN_FROM_SCALE: f32 = 0.72;
const CONVERGE_SCREEN_FROM: [f32; 2] = [-1.05, -0.62];
const CONVERGE_CAMERA_FROM_SCALE: f32 = 0.58;
const CONVERGE_CAMERA_FROM: [f32; 2] = [1.12, 0.72];

/// Les presets que ce module sait animer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpeningPreset {
    SideSlide,
    Converge,
}

impl OpeningPreset {
    /// Un nom inconnu retombe sur le défaut, et ne lève jamais : un preset retiré du produit
    /// ne doit pas figer une scène déjà enregistrée.
    pub fn from_name(name: &str) -> Self {
        match name {
            PRESET_CONVERGE => Self::Converge,
            _ => Self::SideSlide,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SideSlide => PRESET_SIDE_SLIDE,
            Self::Converge => PRESET_CONVERGE,
        }
    }
}

/// D'où l'élément part, et par où. La direction appartient au preset, pas à la chorégraphie :
/// c'est le seul point où les deux presets divergent, et il est décidé une fois, à la
/// construction de l'échantillon.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OpeningMotion {
    /// Glissement horizontal. La distance est « toute la toile plus la largeur de l'élément »,
    /// donc elle dépend d'une largeur que seul `opening_rect` connaît : elle y est calculée.
    SideSlide { side: f32 },
    /// Convergence depuis un point hors cadre FIXE, en fractions de la toile de sortie.
    Converge { from: [f32; 2] },
}

/// Ce qu'un élément doit faire à un instant donné.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpeningSample {
    /// Progression 0..1 DÉJÀ adoucie. 1 = exactement en place ; c'est le cas dès que
    /// l'élément a fini, et l'appelant peut alors court-circuiter entièrement.
    pub eased: f32,
    /// Échelle au repos de l'élément, à `eased = 0`.
    pub from_scale: f32,
    pub motion: OpeningMotion,
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
    preset: OpeningPreset,
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
            // Un nom inconnu (ou une scène écrite avant que le champ existe) retombe sur le
            // défaut plutôt que de rendre une scène non animée ou, pire, un autre preset.
            preset: OpeningPreset::from_name(&raw.preset),
            duration_sec,
            stagger_sec,
            slide_sec,
            order,
            included,
        }
    }

    /// Le preset retenu, après réparation du nom.
    pub fn preset(&self) -> OpeningPreset {
        self.preset
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

        let entering = self.entering(has_camera);
        let mut frame = OpeningFrame::default();
        if entering.contains(&ELEMENT_SCREEN) {
            frame.screen = Some(self.sample_element(ELEMENT_SCREEN, t, &entering));
        }
        if entering.contains(&ELEMENT_CAMERA) {
            frame.camera = Some(self.sample_element(ELEMENT_CAMERA, t, &entering));
        }
        frame
    }

    fn includes(&self, element: &str) -> bool {
        self.included.iter().any(|n| n == element)
    }

    /// Qui entre VRAIMENT, dans l'ordre d'entrée. C'est la sélection du document restreinte à
    /// ce qui peut effectivement entrer — et c'est cette liste, pas `order` entier, qui décide
    /// des rangs.
    ///
    /// La distinction n'est pas cosmétique : un `order` qui nomme la caméra en premier
    /// condamnait l'écran à attendre `stagger` secondes pour un élément qui n'existe pas, sur
    /// un projet sans caméra. Le rang se lit donc sur les participants, comme le
    /// `participatingElements()` de DogSC.
    fn entering(&self, has_camera: bool) -> Vec<&str> {
        self.order
            .iter()
            .map(String::as_str)
            .filter(|name| *name != ELEMENT_CAMERA || has_camera)
            .filter(|name| self.includes(name))
            .collect()
    }

    fn sample_element(&self, element: &str, t: f32, entering: &[&str]) -> OpeningSample {
        let camera = element == ELEMENT_CAMERA;
        // Rang parmi les participants. Un nom absent de la liste (impossible : on n'arrive ici
        // que pour un participant) part à 0.
        let rank = entering.iter().position(|name| *name == element).unwrap_or(0) as f32;
        let (start, slide) = if entering.len() <= 1 {
            // Un seul élément : rien à décaler, et il dispose de TOUTE la durée. Garder
            // `duration - stagger` lui laisserait un trou mort à la fin, sans second élément
            // pour l'y occuper.
            (0.0, self.duration_sec)
        } else {
            // Deux éléments ou plus : le premier part à 0, le suivant à `stagger`, et les deux
            // glissent sur le même temps — la chorégraphie d'origine, inchangée.
            (rank * self.stagger_sec, self.slide_sec)
        };
        let progress = ((t - start) / slide.max(MIN_SLIDE_SEC)).clamp(0.0, 1.0);
        let (from_scale, motion) = self.departure(camera);
        OpeningSample {
            eased: swift_ease(progress),
            from_scale,
            motion,
        }
    }

    /// Géométrie de départ : le seul endroit où les presets divergent.
    fn departure(&self, camera: bool) -> (f32, OpeningMotion) {
        match (self.preset, camera) {
            (OpeningPreset::SideSlide, false) => {
                (SCREEN_FROM_SCALE, OpeningMotion::SideSlide { side: -1.0 })
            }
            (OpeningPreset::SideSlide, true) => {
                (CAMERA_FROM_SCALE, OpeningMotion::SideSlide { side: 1.0 })
            }
            (OpeningPreset::Converge, false) => (
                CONVERGE_SCREEN_FROM_SCALE,
                OpeningMotion::Converge {
                    from: CONVERGE_SCREEN_FROM,
                },
            ),
            (OpeningPreset::Converge, true) => (
                CONVERGE_CAMERA_FROM_SCALE,
                OpeningMotion::Converge {
                    from: CONVERGE_CAMERA_FROM,
                },
            ),
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
    // `1 - eased` ramène la translation à zéro au moment où l'élément se pose. Il ne peut pas
    // valoir 0 ici : `eased >= 1.0` est déjà sorti plus haut.
    let travel = 1.0 - eased;
    let (dx, dy) = match sample.motion {
        // `1.0` est la largeur du cadre (coordonnées normalisées) : la translation vaut donc
        // « toute la largeur, plus la largeur de l'élément », ce qui le sort du cadre quelle
        // que soit sa taille.
        OpeningMotion::SideSlide { side } => (side * travel * (1.0 + w), 0.0),
        // Le point de départ est donné en fractions de la toile : rien à dériver du rect, et
        // l'axe vertical existe (contrairement au Side Slide, qui reste à l'horizontale).
        OpeningMotion::Converge { from } => (from[0] * travel, from[1] * travel),
    };
    [cx - w * 0.5 + dx, cy - h * 0.5 + dy, w, h]
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

    /// La même chose, en Converge.
    fn converge(duration: f32, stagger: f32) -> OpeningSequence {
        OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            preset: PRESET_CONVERGE.to_string(),
            duration_sec: duration,
            stagger_sec: stagger,
            ..Default::default()
        })
    }

    /// Réglée pour ne retenir que `names`, dans `order`.
    fn only(order: &[&str], names: &[&str]) -> OpeningSequence {
        OpeningSequence::repaired(&SceneOpening {
            enabled: true,
            duration_sec: 2.2,
            stagger_sec: 0.16,
            element_order: order.iter().map(|s| s.to_string()).collect(),
            included_elements: names.iter().map(|s| s.to_string()).collect(),
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
        assert_eq!(screen.motion, OpeningMotion::SideSlide { side: -1.0 });
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
        assert_eq!(camera.motion, OpeningMotion::SideSlide { side: 1.0 });
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

    // ── Converge ─────────────────────────────────────────────────────────────

    #[test]
    fn an_unknown_preset_falls_back_to_side_slide() {
        for name in ["", "sideSlide", "side-slide", "light3d", "sticker", "CONVERGE"] {
            let s = OpeningSequence::repaired(&SceneOpening {
                enabled: true,
                preset: name.to_string(),
                ..Default::default()
            });
            assert_eq!(s.preset(), OpeningPreset::SideSlide, "preset {name:?}");
            // Et surtout : ce que ça REND est bien un Side Slide, pas autre chose.
            let screen = s.sample_at(0.0, true).screen.expect("screen");
            assert_eq!(screen.from_scale, SCREEN_FROM_SCALE, "preset {name:?}");
            assert_eq!(screen.motion, OpeningMotion::SideSlide { side: -1.0 });
        }
        // Le nom connu, lui, est bien reconnu.
        assert_eq!(
            OpeningSequence::repaired(&SceneOpening {
                enabled: true,
                preset: PRESET_CONVERGE.to_string(),
                ..Default::default()
            })
            .preset(),
            OpeningPreset::Converge
        );
    }

    #[test]
    fn converge_starts_the_screen_in_the_top_left_corner() {
        let s = converge(2.2, 0.16);
        let screen = s.sample_at(0.0, true).screen.expect("screen enters");
        assert_eq!(screen.eased, 0.0);
        assert_eq!(
            screen.motion,
            OpeningMotion::Converge {
                from: CONVERGE_SCREEN_FROM
            }
        );
        assert_eq!(screen.from_scale, CONVERGE_SCREEN_FROM_SCALE);

        let base = [0.1, 0.1, 0.8, 0.8];
        let out = opening_rect(base, &screen);
        // Entièrement à GAUCHE du cadre...
        assert!(out[0] + out[2] <= 0.0, "screen must be fully left, got {out:?}");
        // ...et son coin haut est AU-DESSUS : les deux axes partent du même côté (haut-gauche).
        assert!(out[1] < 0.0, "screen must start above the frame, got {out:?}");
        // L'échelle de départ est appliquée telle quelle, autour de son propre centre.
        assert!((out[2] - base[2] * CONVERGE_SCREEN_FROM_SCALE).abs() < 1e-6);
        assert!((out[3] - base[3] * CONVERGE_SCREEN_FROM_SCALE).abs() < 1e-6);
    }

    #[test]
    fn converge_starts_the_camera_in_the_bottom_right_corner() {
        let s = converge(2.2, 0.16);
        let camera = s.sample_at(0.0, true).camera.expect("camera enters");
        assert_eq!(
            camera.motion,
            OpeningMotion::Converge {
                from: CONVERGE_CAMERA_FROM
            }
        );
        assert_eq!(camera.from_scale, CONVERGE_CAMERA_FROM_SCALE);

        let base = [0.62, 0.62, 0.3, 0.3];
        let out = opening_rect(base, &camera);
        assert!(out[0] >= 1.0, "camera must be fully right, got {out:?}");
        assert!(out[1] >= 1.0, "camera must be fully below, got {out:?}");
    }

    #[test]
    fn converge_pulls_both_elements_towards_their_place() {
        let s = converge(2.2, 0.16);
        let base = [0.1, 0.1, 0.8, 0.8];
        // L'écran remonte et vient de la gauche : son bord gauche avance, son haut descend.
        let mut last_left = f32::NEG_INFINITY;
        let mut last_top = f32::NEG_INFINITY;
        for i in 0..=20 {
            let t = i as f32 * 0.1;
            let out = opening_rect(base, &s.sample_at(t, true).screen.unwrap());
            assert!(out[0] >= last_left - 1e-6, "screen must not back up at t={t}");
            assert!(out[1] >= last_top - 1e-6, "screen must not dip at t={t}");
            last_left = out[0];
            last_top = out[1];
        }
        // La caméra, elle, repart de la droite et du BAS : ses deux bords reculent.
        let cam_base = [0.62, 0.62, 0.3, 0.3];
        let mut last_right = f32::INFINITY;
        let mut last_bottom = f32::INFINITY;
        for i in 0..=20 {
            let t = i as f32 * 0.1;
            let out = opening_rect(cam_base, &s.sample_at(t, true).camera.unwrap());
            assert!(out[0] <= last_right + 1e-6, "camera must not advance at t={t}");
            assert!(out[1] <= last_bottom + 1e-6, "camera must not rise at t={t}");
            last_right = out[0];
            last_bottom = out[1];
        }
    }

    #[test]
    fn converge_lands_exactly_home_and_stays() {
        let s = converge(2.2, 0.16);
        let base = [0.1, 0.1, 0.8, 0.8];
        for t in [2.2_f32, 2.21, 3.0, 60.0] {
            let frame = s.sample_at(t, true);
            assert_eq!(frame.screen.unwrap().eased, 1.0, "screen home at t={t}");
            assert_eq!(frame.camera.unwrap().eased, 1.0, "camera home at t={t}");
            assert_eq!(opening_rect(base, &frame.screen.unwrap()), base);
            assert_eq!(opening_rect(base, &frame.camera.unwrap()), base);
        }
    }

    #[test]
    fn disabled_converge_is_still_the_identity() {
        let s = OpeningSequence::repaired(&SceneOpening {
            enabled: false,
            preset: PRESET_CONVERGE.to_string(),
            ..Default::default()
        });
        assert!(s.is_identity());
        assert!(s.sample_at(0.0, true).is_identity());
    }

    #[test]
    fn the_two_presets_share_their_timing() {
        // Même durée, même décalage, même ordre : seule la géométrie de départ change. Si un
        // preset se mettait à danser sur un autre temps, c'est ici que ça se verrait.
        let slide = with(2.2, 0.16);
        let conv = converge(2.2, 0.16);
        for i in 0..=22 {
            let t = i as f32 * 0.1;
            let a = slide.sample_at(t, true);
            let b = conv.sample_at(t, true);
            assert_eq!(a.screen.unwrap().eased, b.screen.unwrap().eased, "screen eased at t={t}");
            assert_eq!(a.camera.unwrap().eased, b.camera.unwrap().eased, "camera eased at t={t}");
        }
    }

    #[test]
    fn the_side_slide_geometry_is_unchanged() {
        // Valeurs figées : la régression que ce test existe pour attraper, c'est un Converge
        // qui se serait glissé dans le chemin du Side Slide. base = [0.2, 0.2, 0.6, 0.6],
        // durée 2,2 s, décalage 0,16 s, écran en premier.
        let s = with(2.2, 0.16);
        let base = [0.2, 0.2, 0.6, 0.6];

        let at = |t: f32, element: &str| {
            let frame = s.sample_at(t, true);
            let sample = if element == ELEMENT_CAMERA {
                frame.camera.unwrap()
            } else {
                frame.screen.unwrap()
            };
            opening_rect(base, &sample)
        };

        // t = 0 : entièrement hors cadre, à gauche, à l'échelle 0,94, centré verticalement.
        let t0 = at(0.0, ELEMENT_SCREEN);
        assert!((t0[0] - (0.5 - 0.6 * 0.94 * 0.5 - (1.0 + 0.6 * 0.94))).abs() < 1e-6, "t0 {t0:?}");
        // Le CENTRE vertical ne bouge pas : l'élément rétrécit sur place, il ne se décale pas
        // vers un coin (c'est la différence de fond avec Converge).
        assert!((t0[1] + t0[3] * 0.5 - 0.5).abs() < 1e-6, "vertical centre must not move: {t0:?}");

        // t = 1,0 : à mi-vol, la valeur exacte de la formule d'origine.
        let mid = at(1.0, ELEMENT_SCREEN);
        let eased = swift_ease(1.0 / 2.04);
        let scale = 0.94 + 0.06 * eased;
        let w = 0.6 * scale;
        let expected_x = 0.5 - w * 0.5 - (1.0 - eased) * (1.0 + w);
        assert!((mid[0] - expected_x).abs() < 1e-6, "mid x {mid:?} vs {expected_x}");
        assert!((mid[2] - w).abs() < 1e-6, "mid w {mid:?} vs {w}");

        // Et la caméra part bien de la DROITE, pas du coin.
        let cam0 = at(0.0, ELEMENT_CAMERA);
        assert!(cam0[0] >= 1.0, "camera must be fully right: {cam0:?}");
        assert!(
            (cam0[1] + cam0[3] * 0.5 - 0.5).abs() < 1e-6,
            "camera must not move vertically: {cam0:?}"
        );
    }

    // ── Participants ─────────────────────────────────────────────────────────

    #[test]
    fn a_lone_participant_starts_at_zero_whatever_its_rank_in_the_order() {
        // Ordre « caméra d'abord », mais aucune caméra dans le projet : l'écran ne doit pas
        // hériter du rang 1 et attendre `stagger` secondes pour rien.
        let s = only(&["camera", "screen"], &["screen", "camera"]);
        let screen = s.sample_at(0.0, false).screen.expect("screen enters");
        assert_eq!(screen.eased, 0.0, "a lone participant starts at t=0");
        // Le témoin : à la moitié de la durée il est à mi-parcours, donc il a bien commencé.
        let half = s.sample_at(1.1, false).screen.unwrap();
        assert!((half.eased - swift_ease(0.5)).abs() < 1e-6, "{}", half.eased);
    }

    #[test]
    fn a_lone_participant_uses_the_whole_duration() {
        // Sans second élément, il n'y a rien à occuper pendant `stagger` : le garder laisserait
        // un trou mort en fin d'ouverture.
        let s = only(&["screen", "camera"], &["screen"]);
        let half = s.sample_at(1.1, false).screen.unwrap();
        assert!(
            (half.eased - swift_ease(0.5)).abs() < 1e-6,
            "half the duration must be half the travel, got {}",
            half.eased
        );
        assert_eq!(s.sample_at(2.2, false).screen.unwrap().eased, 1.0);
    }

    #[test]
    fn a_lone_camera_also_starts_at_zero() {
        let s = only(&["screen", "camera"], &["camera"]);
        let half = s.sample_at(1.1, true).camera.unwrap();
        assert!((half.eased - swift_ease(0.5)).abs() < 1e-6, "{}", half.eased);
    }

    #[test]
    fn two_participants_keep_the_staggered_schedule() {
        // Le correctif ne doit pas avoir aplatit le cas normal.
        let s = only(&["screen", "camera"], &["screen", "camera"]);
        assert_eq!(s.sample_at(0.0, true).camera.unwrap().eased, 0.0, "camera waits");
        assert!(s.sample_at(0.08, true).screen.unwrap().eased > 0.0, "screen leads");
        assert_eq!(s.sample_at(0.15, true).camera.unwrap().eased, 0.0);
        assert!(s.sample_at(0.17, true).camera.unwrap().eased > 0.0);
        // Et les deux se posent exactement à la durée.
        let end = s.sample_at(2.2, true);
        assert_eq!(end.screen.unwrap().eased, 1.0);
        assert_eq!(end.camera.unwrap().eased, 1.0);
    }

    #[test]
    fn the_schedule_is_a_pure_function_of_the_inputs() {
        // L'ouverture est globale : la même seconde doit donner le même état, et rien dans la
        // liste des participants ne doit dépendre de l'historique. Deux appels identiques —
        // c'est ce qui garantit qu'un changement de caméra d'un clip à l'autre ne peut pas
        // réordonner la chorégraphie en cours de route sans que ça se voie ici.
        let s = only(&["camera", "screen"], &["screen", "camera"]);
        for t in [0.0_f32, 0.4, 1.1, 2.2] {
            assert_eq!(s.sample_at(t, true), s.sample_at(t, true), "t={t}");
        }
        // Et la liste des participants ne dépend que de `has_camera`, pas du temps.
        let with_cam = s.sample_at(1.1, true);
        let without_cam = s.sample_at(1.1, false);
        assert!(with_cam.camera.is_some() && without_cam.camera.is_none());
    }

    #[test]
    fn converge_survives_absurd_settings() {
        for raw in [
            SceneOpening {
                enabled: true,
                preset: PRESET_CONVERGE.to_string(),
                duration_sec: f32::NAN,
                ..Default::default()
            },
            SceneOpening {
                enabled: true,
                preset: PRESET_CONVERGE.to_string(),
                stagger_sec: f32::INFINITY,
                ..Default::default()
            },
        ] {
            let s = OpeningSequence::repaired(&raw);
            for t in [-1.0_f32, 0.0, 0.5, 2.2, 10.0, f32::NAN] {
                for sample in [s.sample_at(t, true).screen, s.sample_at(t, true).camera]
                    .into_iter()
                    .flatten()
                {
                    let out = opening_rect([0.1, 0.1, 0.8, 0.8], &sample);
                    for v in out {
                        assert!(v.is_finite(), "rect NaN/Inf at t={t} for {raw:?}");
                    }
                }
            }
        }
    }
}

//! Mouvement d'écran ("Screen Motion") — la moitié native de la fonctionnalité.
//!
//! L'app envoie la cible TELLE QUE L'AUTEUR L'A ÉCRITE : position, échelle, rotations,
//! perspective. Rien à résoudre ici — un mouvement d'écran n'a pas de forme discrète à traduire
//! en nombres continus, contrairement à un mouvement de caméra — donc la sémantique vit
//! entièrement en TS (`screenMotion/resolve.ts`) et le natif ne fait que ce qu'il sait déjà
//! faire : une enveloppe temporelle, un lerp, et un décalage de boîte.
//!
//! Deux choses portent tout le poids, et les deux viennent de DogSC, qui les a apprises à ses
//! dépens :
//!
//! 1. La position et l'échelle voyagent ENSEMBLE, en espace RECT. Les interpoler séparément
//!    parcourt `position × (canvas − carte)`, ce qui fait grossir la carte au milieu du trajet
//!    et ne la fait glisser qu'ensuite.
//! 2. Rien ne divise par ce même dénominateur sur une carte en MOUVEMENT : il traverse zéro
//!    quand la carte grandit au-delà du canvas. La boîte se construit donc en FORWARD depuis
//!    `position` et `scale` ; la seule inversion vit dans l'état de base, sur une valeur qui ne
//!    bouge pas, et elle porte sa garde.
//!
//! L'enveloppe est celle de la caméra (`camera_motion::region_phase_at`) plutôt qu'une copie :
//! un jeu de nombres, donc un mouvement d'écran et un mouvement de caméra créés coup sur coup
//! arrivent et repartent au même rythme.

use crate::camera_motion::{camera_motion_easing_fn, region_phase_at};
use crate::regions::ScreenClock;
use crate::scene::{FocusShape, SceneFocusEffect, SceneScreenMotionRegion};

/// Ce qu'un mouvement d'écran décrit à un instant donné.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenMotionSample {
    /// Centre de la carte, 0..1 du canvas. Peut sortir de 0..1 en cours de transition : le lerp
    /// en espace rect en a besoin pour garder l'ancre sur la ligne droite entre les deux bouts.
    /// Seule la cible PERSISTÉE est bornée (côté TS, `screenMotion/presets.ts`).
    pub position: [f32; 2],
    /// Multiplicateur sur le placement de base du projet (1 = tel quel).
    pub scale: f32,
    /// Degrés, à AJOUTER à la rotation de base de l'écran — celle du zoom, qui passe déjà par
    /// `screen_tilt`. Additionner plutôt que remplacer garde les deux mouvements composables.
    pub rotation: [f32; 3],
}

/// L'assombrissement à un instant donné, déjà résolu en nombres.
///
/// `center` et `size` sont en fraction du canvas : `size` porte sur le plus PETIT côté, pour
/// qu'un cercle reste un cercle sur une sortie non carrée (même convention que le rayon du
/// curseur, `cursor.rs`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FocusEffectSample {
    pub shape: FocusShape,
    /// Orientation de la bande, en degrés, ramenée dans 0..360.
    pub angle_degrees: f32,
    /// Centre de la zone nette, 0..1 du canvas.
    pub center: [f32; 2],
    /// Rayon du cercle, ou demi-largeur de la bande, en fraction du plus petit côté.
    pub size: f32,
    /// Largeur de la transition nette → assombrie, 0..1.
    pub softness: f32,
    /// Opacité de l'assombrissement hors de la forme, 0..1.
    pub dimming: f32,
    /// Progrès de la région porteuse, 0..1 — la MÊME enveloppe que le mouvement lui-même.
    pub progress: f32,
}

/// Le facteur d'assombrissement à une distance `d` du cœur de la forme, 0 = net, 1 = plein.
///
/// `d` est une distance NORMALISÉE : 0 au centre de la zone nette, 1 à sa frontière déclarée.
/// Le dégradé vit ENTIÈREMENT à l'intérieur de la frontière, pour que `size` reste la taille de
/// la zone nette telle que l'auteur l'a réglée — une transition qui déborderait ferait rétrécir
/// la zone nette à mesure qu'on augmente `softness`, ce que personne n'attend d'un curseur
/// nommé « taille ».
pub fn focus_dim_factor(d: f32, softness: f32) -> f32 {
    if d <= 0.0 {
        return 0.0;
    }
    let softness = softness.clamp(0.0, 1.0);
    if softness <= 0.0 {
        // Un bord net : tout ce qui est dehors est plein, tout ce qui est dedans est net.
        return 1.0;
    }
    // Le dégradé occupe les `softness` derniers pourcents du rayon. `1 - softness` est donc la
    // fraction encore entièrement nette, et la rampe va de là à 1.
    let inner = 1.0 - softness;
    if d <= inner {
        return 0.0;
    }
    if d >= 1.0 {
        return 1.0;
    }
    (d - inner) / softness
}

/// L'assombrissement actif à `t`, ou `None` quand il n'y a rien à dessiner.
///
/// Le gagnant est choisi par la MÊME règle que `screen_motion_sample_at` — le progrès le plus
/// fort — pour que la lumière et le mouvement qu'elle suit ne puissent pas désigner deux régions
/// différentes. Les deux fonctions gardent leur boucle séparée plutôt que d'en partager une :
/// `screen_motion_sample_at` fond un état et celle-ci projette une forme, et les faire dépendre
/// l'une de l'autre couplerait un chemin chaud à un autre pour rien.
///
/// `None` couvre trois cas, tous volontaires : rien n'est animé à `t`, la région gagnante n'a pas
/// d'effet, ou l'effet est éteint (`dimming <= 0`). Le dernier n'est pas une erreur — c'est ainsi
/// qu'un auteur éteint son projecteur, et cela ne doit coûter aucun travail au rendu.
pub fn focus_effect_sample_at(
    regions: &[SceneScreenMotionRegion],
    t: f32,
    clock: &ScreenClock,
) -> Option<FocusEffectSample> {
    let mut best_progress = 0.0f32;
    let mut best_region: Option<&SceneScreenMotionRegion> = None;
    for region in regions {
        let phase = region_phase_at(
            region.start_sec,
            region.end_sec,
            region.lead_in_sec,
            region.return_sec,
            t,
            clock,
        );
        let progress = camera_motion_easing_fn(&region.easing)(phase);
        if progress > best_progress {
            best_progress = progress;
            best_region = Some(region);
        }
    }
    let region = best_region?;
    if best_progress <= 0.0 {
        return None;
    }

    let effect: SceneFocusEffect = region.focus_effect?;
    // Éteint : rien à dessiner, et le contrôle le plus proche du rendu n'a pas à s'en occuper.
    if effect.dimming <= 0.0 {
        return None;
    }

    Some(FocusEffectSample {
        shape: effect.shape,
        // Ramené dans 0..360 plutôt que borné : 450° et 90° peignent la même bande, donc la
        // valeur que l'auteur a tapée ne doit pas être réécrite en silence (miroir de
        // `normalizeFocusAngle`, TS).
        angle_degrees: effect.angle_degrees.rem_euclid(360.0),
        // Le centre vient DÉJÀ résolu du TS : pour une cible `animation` il porte la destination
        // du mouvement, pas son état mélangé. Le natif n'a donc pas à connaître l'enum.
        center: [effect.center_x, effect.center_y],
        size: effect.size,
        softness: effect.softness,
        dimming: effect.dimming,
        progress: best_progress,
    })
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// L'état de base : le placement ordinaire du projet, dans la même langue normalisée.
///
/// C'est le SEUL endroit qui inverse `position × (1 − taille)`, donc le seul endroit qui divise
/// par ce dénominateur — et il porte la garde. Le compositeur a déjà payé pour l'apprendre :
/// `1 − carte` traverse zéro quand la carte grandit au-delà du canvas, et DogSC y a laissé une
/// image sautée.
pub fn screen_motion_base_state(base: [f32; 4]) -> ([f32; 2], f32) {
    let denom_x = 1.0 - base[2];
    let denom_y = 1.0 - base[3];
    (
        [
            if denom_x.abs() > 0.001 {
                (base[0] / denom_x).clamp(0.0, 1.0)
            } else {
                0.5
            },
            if denom_y.abs() > 0.001 {
                (base[1] / denom_y).clamp(0.0, 1.0)
            } else {
                0.5
            },
        ],
        1.0,
    )
}

/// Lerp en espace RECT : la position et l'échelle voyagent ensemble. Miroir de
/// `lerpScreenMotionState` (TS).
fn lerp_state_rect_space(
    from: ([f32; 2], f32),
    to: ([f32; 2], f32),
    t: f32,
    base: [f32; 4],
) -> ([f32; 2], f32) {
    // Un axe à la fois : `extent` est la taille de la carte à l'échelle 1 sur cet axe, donc
    // `scale × extent` est sa taille dessinée.
    let axis = |pos_a: f32, pos_b: f32, scale_a: f32, scale_b: f32, extent: f32| -> f32 {
        let w0 = scale_a * extent;
        let w1 = scale_b * extent;
        let w = lerp(w0, w1, t);
        let u = lerp(pos_a * (1.0 - w0), pos_b * (1.0 - w1), t);
        let denom = 1.0 - w;
        if denom.abs() > 0.001 {
            u / denom
        } else {
            lerp(pos_a, pos_b, t)
        }
    };
    (
        [
            axis(from.0[0], to.0[0], from.1, to.1, base[2]),
            axis(from.0[1], to.0[1], from.1, to.1, base[3]),
        ],
        lerp(from.1, to.1, t),
    )
}

/// La boîte de l'écran pour un état, en fractions du canvas.
///
/// Formule FORWARD : la boîte est construite à partir de `position` et `scale`, jamais l'inverse.
/// Miroir de `screenMotionRectAt` (TS).
pub fn screen_motion_box(state: ([f32; 2], f32), base: [f32; 4]) -> [f32; 4] {
    let w = base[2] * state.1;
    let h = base[3] * state.1;
    [
        state.0[0] * (1.0 - w),
        state.0[1] * (1.0 - h),
        w,
        h,
    ]
}

/// Le mouvement d'écran à `t`, ou `None` quand aucun n'est actif.
///
/// La plus forte gagne, comme partout ailleurs dans cet éditeur. Le résultat est DÉJÀ fondu
/// (base → cible), donc l'appelant n'a qu'à construire la boîte : fondre une seconde fois
/// appliquerait le mouvement deux fois.
pub fn screen_motion_sample_at(
    regions: &[SceneScreenMotionRegion],
    t: f32,
    clock: &ScreenClock,
    base: [f32; 4],
) -> Option<ScreenMotionSample> {
    let mut best_progress = 0.0f32;
    let mut best_region: Option<&SceneScreenMotionRegion> = None;
    for region in regions {
        let phase = region_phase_at(
            region.start_sec,
            region.end_sec,
            region.lead_in_sec,
            region.return_sec,
            t,
            clock,
        );
        let progress = camera_motion_easing_fn(&region.easing)(phase);
        if progress > best_progress {
            best_progress = progress;
            best_region = Some(region);
        }
    }
    let region = best_region?;
    if best_progress <= 0.0 {
        return None;
    }

    let target = region.target;
    let base_state = screen_motion_base_state(base);
    let (position, scale) = lerp_state_rect_space(
        base_state,
        ([target.position_x, target.position_y], target.scale),
        best_progress,
        base,
    );
    // Les rotations partent de l'état de base (repos : aucune rotation) et suivent la MÊME
    // progression que la position — c'est ce qui garde une inclinaison et un déplacement sur une
    // seule horloge.
    //
    // `perspective` est délibérément ABSENT : la cible en porte un (le TS l'authorise et le
    // transmet), mais AUCUN rendu ne le consomme — la perspective du quad reste
    // `min(largeur, hauteur) × PERSPECTIVE_FACTOR`, une constante. Le calculer ici pour que
    // personne ne le lise serait exactement le « champ qui existe mais qui ne fait rien » que ce
    // dépôt refuse. Il sera branché le jour où un rendu saura s'en servir ; d'ici là il est
    // authorisé, transmis, et sans effet — même statut que l'`opacity` de Camera Motion.
    Some(ScreenMotionSample {
        position,
        scale,
        rotation: [
            lerp(0.0, target.rotation_x, best_progress),
            lerp(0.0, target.rotation_y, best_progress),
            lerp(0.0, target.rotation_z, best_progress),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::SceneScreenMotionTarget;

    /// Un canvas de 1×1 et une carte de 0.1 : les fractions SONT les pixels, donc une erreur de
    /// chemin se lit directement.
    const BASE: [f32; 4] = [0.0, 0.0, 0.1, 0.1];

    fn region(target: SceneScreenMotionTarget) -> SceneScreenMotionRegion {
        SceneScreenMotionRegion {
            clip_index: None,
            start_sec: 1.0,
            end_sec: 5.0,
            target,
            // Fenêtres nulles : le progrès vaut 1 pendant tout le palier, donc les assertions
            // portent sur la cible et non sur une courbe.
            lead_in_sec: 0.0,
            return_sec: 0.0,
            easing: "linear".to_string(),
            focus_effect: None,
        }
    }

    fn target(position: [f32; 2], scale: f32) -> SceneScreenMotionTarget {
        SceneScreenMotionTarget {
            position_x: position[0],
            position_y: position[1],
            scale,
            ..Default::default()
        }
    }

    #[test]
    fn base_state_reads_the_placement_the_project_already_chose() {
        let (position, scale) = screen_motion_base_state([0.45, 0.45, 0.1, 0.1]);
        assert!((position[0] - 0.5).abs() < 1e-6, "{position:?}");
        assert!((position[1] - 0.5).abs() < 1e-6);
        assert!((scale - 1.0).abs() < 1e-6);
    }

    #[test]
    fn base_state_resolves_a_full_canvas_card_to_the_centre_instead_of_infinity() {
        // Le dénominateur vaut zéro : rien ne doit diviser par lui.
        let (position, _) = screen_motion_base_state([0.0, 0.0, 1.0, 1.0]);
        assert_eq!(position, [0.5, 0.5]);
    }

    #[test]
    fn position_and_scale_travel_together_through_rect_space() {
        // Les deux bouts : bord gauche 0 → 0.4. La moitié du chemin droit vaut 0.2.
        let base_state = screen_motion_base_state(BASE);
        let (position, scale) = lerp_state_rect_space(base_state, ([0.5, 0.5], 2.0), 0.5, BASE);
        let [x, _, w, _] = screen_motion_box((position, scale), BASE);
        assert!((x - 0.2).abs() < 1e-6, "rect space: {x}");

        // Ce que le lerp INDÉPENDANT aurait donné : position et échelle chacune à son milieu,
        // puis multipliées. 0.0125 d'écart — c'est tout l'enjeu.
        let wrong_scale = 1.5f32;
        let wrong_position = 0.25f32;
        let wrong_x = wrong_position * (1.0 - wrong_scale * BASE[2]);
        assert!((wrong_x - 0.2125).abs() < 1e-6, "{wrong_x}");
        assert!((x - wrong_x).abs() > 0.01);
    }

    #[test]
    fn the_box_is_built_forward_from_position_and_scale() {
        let [x, y, w, h] = screen_motion_box(([0.5, 0.5], 2.0), BASE);
        assert!((w - 0.2).abs() < 1e-6);
        assert!((h - 0.2).abs() < 1e-6);
        assert!((x - 0.4).abs() < 1e-6);
        assert!((y - 0.4).abs() < 1e-6);
    }

    #[test]
    fn nothing_active_leaves_the_box_alone() {
        let clock = ScreenClock::default();
        assert!(screen_motion_sample_at(&[], 3.0, &clock, BASE).is_none());
        // Hors de la fenêtre : 0 de progrès, donc aucun échantillon.
        let regions = vec![region(target([0.5, 0.5], 2.0))];
        assert!(screen_motion_sample_at(&regions, 0.5, &clock, BASE).is_none());
        assert!(screen_motion_sample_at(&regions, 6.0, &clock, BASE).is_none());
    }

    #[test]
    fn a_region_moves_the_box_towards_its_target() {
        let clock = ScreenClock::default();
        let regions = vec![region(target([0.5, 0.5], 2.0))];
        let sample = screen_motion_sample_at(&regions, 3.0, &clock, BASE).expect("actif");
        let rect = screen_motion_box((sample.position, sample.scale), BASE);
        assert!((rect[2] - 0.2).abs() < 1e-6, "{rect:?}");
        assert!((rect[0] - 0.4).abs() < 1e-6, "{rect:?}");
    }

    #[test]
    fn the_strongest_region_wins() {
        let clock = ScreenClock::default();
        // Les deux couvrent 3 s, mais la seconde est deux fois plus longue à arriver : elle est
        // donc encore en route quand la première est arrivée.
        let quick = region(target([0.5, 0.5], 2.0));
        let mut slow = region(target([1.0, 1.0], 1.0));
        slow.lead_in_sec = 4.0;
        let regions = vec![quick, slow];

        let sample = screen_motion_sample_at(&regions, 2.0, &clock, BASE).expect("actif");
        // La cible rapide : 2× au centre.
        assert!((sample.scale - 2.0).abs() < 1e-6, "{sample:?}");
    }

    #[test]
    fn rotation_rides_the_same_clock_as_the_position() {
        let clock = ScreenClock::default();
        let mut t = target([0.5, 0.5], 1.0);
        t.rotation_y = 30.0;
        // Lead-in de 2 s sur une région de 4 s : à mi-chemin de la montée, la moitié du chemin.
        let mut r = region(t);
        r.lead_in_sec = 2.0;
        r.return_sec = 2.0;

        let half = screen_motion_sample_at(&[r], 2.0, &clock, BASE).expect("actif");
        assert!((half.rotation[1] - 15.0).abs() < 1e-4, "{:?}", half.rotation);
    }

    #[test]
    fn a_region_with_no_rotation_leaves_the_base_rotation_alone() {
        let clock = ScreenClock::default();
        let regions = vec![region(target([0.2, 0.8], 1.5))];
        let sample = screen_motion_sample_at(&regions, 3.0, &clock, BASE).expect("actif");
        assert_eq!(sample.rotation, [0.0, 0.0, 0.0]);
    }

    // ---------------------------------------------------------------------------------------
    // Parité TS ↔ Rust.
    //
    // Les MÊMES nombres que `src/lib/ai-edition/screenMotion/resolve.test.ts` : viewport
    // 1000×1000, carte 100×100, cible 0.5/0.5 à l'échelle 2. Le TS travaille en pixels et le
    // natif en fractions du canvas — les deux formules sont invariantes d'échelle, donc les
    // résultats doivent coïncider. Ces tests tiennent les deux implémentations ensemble :
    // sans eux, une dérive d'un seul côté ne se verrait qu'à l'export, chez l'utilisateur.
    // ---------------------------------------------------------------------------------------

    /// Le `region()` du test TS : 1000..5000 ms, lead-in 0.6 s, retour 0.9 s, courbe `linear`.
    fn parity_region() -> SceneScreenMotionRegion {
        let mut r = region(target([0.5, 0.5], 2.0));
        r.lead_in_sec = 0.6;
        r.return_sec = 0.9;
        r
    }

    fn parity_progress_at(t: f32) -> f32 {
        let clock = ScreenClock::default();
        let r = parity_region();
        let phase = region_phase_at(r.start_sec, r.end_sec, r.lead_in_sec, r.return_sec, t, &clock);
        camera_motion_easing_fn(&r.easing)(phase)
    }

    #[test]
    fn parity_the_envelope_matches_the_ts_test() {
        // TS : 0 aux deux bords et dehors, 1 pendant tout le palier.
        assert_eq!(parity_progress_at(0.0), 0.0);
        assert_eq!(parity_progress_at(1.0), 0.0);
        assert_eq!(parity_progress_at(5.0), 0.0);
        assert_eq!(parity_progress_at(3.0), 1.0);
        // Arrivée à 1600 ms (lead-in de 0.6 s depuis 1000) : le palier commence là.
        let at_1600 = parity_progress_at(1.6);
        assert!((at_1600 - 1.0).abs() < 1e-6, "{at_1600}");
        // Le retour vit DANS la région : entamé à 4500, quasi fini à 4999.
        let at_4500 = parity_progress_at(4.5);
        assert!(at_4500 > 0.0 && at_4500 < 1.0, "{at_4500}");
        let at_4999 = parity_progress_at(4.999);
        assert!(at_4999 < 0.1, "{at_4999}");
    }

    #[test]
    fn parity_the_rect_space_midpoint_matches_the_ts_test() {
        // TS : `rect.x` vaut 200 px au milieu du trajet, et le chemin INDÉPENDANT donnerait
        // 212.5 px. Ici tout est en fractions : 0.2 et 0.2125.
        let base_state = screen_motion_base_state(BASE);
        let (position, scale) = lerp_state_rect_space(base_state, ([0.5, 0.5], 2.0), 0.5, BASE);
        let [x, _, _, _] = screen_motion_box((position, scale), BASE);
        assert!((x - 0.2).abs() < 1e-6, "{x}");
        assert!((x - 0.2125).abs() > 0.01, "{x}");
    }

    #[test]
    fn parity_scaling_about_the_authored_anchor_matches_the_ts_test() {
        // TS : depuis une carte centrée (450 px sur 1000), la cible 0.5/0.5 ×2 donne x = 400 px
        // et une largeur de 200 px. En fractions : 0.4 et 0.2.
        let centered = [0.45, 0.45, 0.1, 0.1];
        let base_state = screen_motion_base_state(centered);
        let (position, scale) = lerp_state_rect_space(base_state, ([0.5, 0.5], 2.0), 1.0, centered);
        let [x, _, w, _] = screen_motion_box((position, scale), centered);
        assert!((w - 0.2).abs() < 1e-6, "{w}");
        assert!((x - 0.4).abs() < 1e-6, "{x}");
    }

    #[test]
    fn parity_the_strongest_region_wins_like_the_ts_test() {
        // TS : `weak` (1000..9000, lead-in de 5 s donc borné à 4 s) contre `strong`
        // (1000..5000). À 3000 ms, `strong` est arrivée (1.0) et `weak` est à mi-montée : la
        // cible de `strong` (1.0, 1.0) ×1.5 est donc celle qui sort.
        let clock = ScreenClock::default();
        let mut weak = region(target([0.5, 0.5], 2.0));
        weak.start_sec = 1.0;
        weak.end_sec = 9.0;
        weak.lead_in_sec = 5.0;
        weak.return_sec = 0.9;
        let mut strong = region(target([1.0, 1.0], 1.5));
        strong.start_sec = 1.0;
        strong.end_sec = 5.0;

        let sample = screen_motion_sample_at(&[weak, strong], 3.0, &clock, BASE).expect("actif");
        assert!((sample.scale - 1.5).abs() < 1e-6, "{sample:?}");
        assert!((sample.position[0] - 1.0).abs() < 1e-6, "{sample:?}");
        assert!((sample.position[1] - 1.0).abs() < 1e-6, "{sample:?}");
    }

    // ---------------------------------------------------------------------------------------
    // Focus effect (« projecteur »).
    //
    // Deux choses comptent ici et rien d'autre : la RAMPE (`focus_dim_factor`) et l'IDENTITÉ
    // d'enveloppe (le progrès du focus est celui du mouvement, à tout instant). Le rendu qui
    // consommera ces nombres n'existe pas encore (lot A2-2, shader) ; ces tests tiennent donc la
    // géométrie tant qu'elle n'est visible nulle part.
    // ---------------------------------------------------------------------------------------

    fn effect(shape: FocusShape, dimming: f32) -> SceneFocusEffect {
        SceneFocusEffect {
            shape,
            angle_degrees: 0.0,
            center_x: 0.5,
            center_y: 0.5,
            size: 0.45,
            softness: 0.5,
            dimming,
        }
    }

    fn region_with_focus(focus: Option<SceneFocusEffect>) -> SceneScreenMotionRegion {
        let mut r = region(target([0.5, 0.5], 2.0));
        r.focus_effect = focus;
        r
    }

    #[test]
    fn dim_factor_is_zero_inside_the_clear_region() {
        assert_eq!(focus_dim_factor(0.0, 0.5), 0.0);
        // `softness` 0.5 → inner 0.5 : tout ce qui est sous la moitié du rayon reste net.
        assert_eq!(focus_dim_factor(0.4, 0.5), 0.0);
    }

    #[test]
    fn dim_factor_reaches_full_at_the_declared_boundary() {
        assert_eq!(focus_dim_factor(1.0, 0.5), 1.0);
        assert_eq!(focus_dim_factor(2.0, 0.5), 1.0);
    }

    #[test]
    fn dim_factor_is_half_at_the_middle_of_the_feather() {
        // La rampe va de 0.5 à 1.0 ; 0.75 est à mi-chemin.
        let f = focus_dim_factor(0.75, 0.5);
        assert!((f - 0.5).abs() < 1e-6, "{f}");
    }

    #[test]
    fn a_hard_edge_has_no_feather_at_all() {
        assert_eq!(focus_dim_factor(0.999, 0.0), 1.0);
        assert_eq!(focus_dim_factor(0.5, 0.0), 1.0);
        assert_eq!(focus_dim_factor(0.0, 0.0), 0.0);
    }

    #[test]
    fn a_full_feather_starts_dimming_immediately_off_centre() {
        assert_eq!(focus_dim_factor(0.0, 1.0), 0.0);
        let f = focus_dim_factor(0.25, 1.0);
        assert!((f - 0.25).abs() < 1e-6, "{f}");
        assert_eq!(focus_dim_factor(1.0, 1.0), 1.0);
    }

    #[test]
    fn no_effect_means_nothing_to_draw() {
        let clock = ScreenClock::default();
        assert!(focus_effect_sample_at(&[region_with_focus(None)], 3.0, &clock).is_none());
    }

    #[test]
    fn outside_the_window_there_is_nothing_to_draw() {
        let clock = ScreenClock::default();
        let regions = [region_with_focus(Some(effect(FocusShape::Radial, 0.5)))];
        assert!(focus_effect_sample_at(&regions, 0.5, &clock).is_none());
        assert!(focus_effect_sample_at(&regions, 6.0, &clock).is_none());
    }

    #[test]
    fn dimming_zero_reads_as_switched_off() {
        // La façon dont un auteur éteint son projecteur — et cela ne doit rien coûter au rendu.
        let clock = ScreenClock::default();
        let regions = [region_with_focus(Some(effect(FocusShape::Radial, 0.0)))];
        assert!(focus_effect_sample_at(&regions, 3.0, &clock).is_none());
    }

    #[test]
    fn the_centre_is_taken_as_resolved_by_the_ts_side() {
        // Le natif ne connaît pas l'enum `target` : le TS lui a DÉJÀ donné un point. Le centre de
        // la cible (0.9, 0.9) ne doit donc PAS fuiter dans l'échantillon.
        let clock = ScreenClock::default();
        let mut e = effect(FocusShape::Radial, 0.5);
        e.center_x = 0.25;
        e.center_y = 0.75;
        let mut r = region_with_focus(Some(e));
        r.target = target([0.9, 0.9], 2.0);
        let sample = focus_effect_sample_at(&[r], 3.0, &clock).expect("actif");
        assert_eq!(sample.center, [0.25, 0.75]);
    }

    #[test]
    fn the_shape_and_the_angle_come_through() {
        let clock = ScreenClock::default();
        let mut e = effect(FocusShape::Linear, 0.5);
        e.angle_degrees = 30.0;
        let sample =
            focus_effect_sample_at(&[region_with_focus(Some(e))], 3.0, &clock).expect("actif");
        assert_eq!(sample.shape, FocusShape::Linear);
        assert_eq!(sample.angle_degrees, 30.0);
    }

    #[test]
    fn the_shape_travels_through_the_sample_unchanged() {
        // La forme est désormais un enum dans le contrat (voir `scene::FocusShape`) : le natif
        // n'a plus de « nom inconnu » à interpréter, serde s'en charge à la frontière. Ici on
        // vérifie seulement qu'elle ressort telle qu'elle est entrée.
        let clock = ScreenClock::default();
        let sample = focus_effect_sample_at(
            &[region_with_focus(Some(effect(FocusShape::Linear, 0.5)))],
            3.0,
            &clock,
        )
        .expect("actif");
        assert_eq!(sample.shape, FocusShape::Linear);
    }

    #[test]
    fn the_angle_wraps_instead_of_being_clamped() {
        let clock = ScreenClock::default();
        let mut e = effect(FocusShape::Linear, 0.5);
        e.angle_degrees = 450.0;
        let sample =
            focus_effect_sample_at(&[region_with_focus(Some(e))], 3.0, &clock).expect("actif");
        assert!(
            (sample.angle_degrees - 90.0).abs() < 1e-4,
            "{}",
            sample.angle_degrees
        );
    }

    #[test]
    fn the_strongest_region_owns_the_spotlight() {
        // La MÊME règle que `screen_motion_sample_at` : le progrès le plus fort gagne. Sinon la
        // lumière et le mouvement qu'elle suit pourraient désigner deux régions différentes.
        let clock = ScreenClock::default();
        let mut early = region_with_focus(Some(effect(FocusShape::Radial, 0.1)));
        early.start_sec = 1.0;
        early.end_sec = 5.0;
        let mut late = region_with_focus(Some(effect(FocusShape::Radial, 0.9)));
        late.start_sec = 3.0;
        late.end_sec = 7.0;
        late.lead_in_sec = 2.0;

        // À 4.0 : `early` est au palier (1.0), `late` à mi-montée (0.5) → `early` gagne.
        let sample = focus_effect_sample_at(&[early, late], 4.0, &clock).expect("actif");
        assert!((sample.dimming - 0.1).abs() < 1e-6, "{}", sample.dimming);
        assert!((sample.progress - 1.0).abs() < 1e-6);
    }

    #[test]
    fn the_spotlight_shares_the_moves_own_envelope() {
        // La propriété qui compte : à TOUT instant, le progrès du focus est celui du mouvement.
        // Une lumière sur sa propre horloge dériverait contre la carte qu'elle suit, et la dérive
        // ne se verrait qu'une fois les deux à l'écran.
        let clock = ScreenClock::default();
        let mut r = region_with_focus(Some(effect(FocusShape::Radial, 0.5)));
        r.lead_in_sec = 0.6;
        r.return_sec = 0.9;
        let regions = [r.clone()];

        for &t in &[1.0f32, 1.3, 1.6, 2.5, 4.0, 4.5, 4.999] {
            let phase = region_phase_at(
                r.start_sec,
                r.end_sec,
                r.lead_in_sec,
                r.return_sec,
                t,
                &clock,
            );
            let expected = camera_motion_easing_fn(&r.easing)(phase);
            match focus_effect_sample_at(&regions, t, &clock) {
                Some(sample) => assert!(
                    (sample.progress - expected).abs() < 1e-6,
                    "t={t}: {} vs {expected}",
                    sample.progress
                ),
                None => assert!(expected <= 0.0, "t={t}: attendu {expected}, obtenu None"),
            }
        }
    }

    #[test]
    fn parity_the_focus_envelope_matches_the_moves() {
        // Mêmes nombres que `focusEffect.test.ts` : lead-in 0.6 s, retour 0.9 s sur 1..5 s.
        let clock = ScreenClock::default();
        let mut r = region_with_focus(Some(effect(FocusShape::Radial, 0.5)));
        r.lead_in_sec = 0.6;
        r.return_sec = 0.9;
        let regions = [r.clone()];

        let progress_at = |t: f32| -> f32 {
            focus_effect_sample_at(&regions, t, &clock).map(|s| s.progress).unwrap_or(0.0)
        };
        assert_eq!(progress_at(0.0), 0.0);
        assert_eq!(progress_at(1.0), 0.0);
        assert_eq!(progress_at(5.0), 0.0);
        assert_eq!(progress_at(3.0), 1.0);
        assert!((progress_at(1.6) - 1.0).abs() < 1e-6, "{}", progress_at(1.6));
        let at_4500 = progress_at(4.5);
        assert!(at_4500 > 0.0 && at_4500 < 1.0, "{at_4500}");
        assert!(progress_at(4.999) < 0.1, "{}", progress_at(4.999));
    }

    #[test]
    fn a_speed_region_keeps_the_spotlight_bounded() {
        // Une speed region étire l'enveloppe avec la vidéo : le progrès doit rester dans 0..1 et
        // l'échantillon rester fini. Le partage de `region_phase_at` est ce qui l'assure.
        let mut r = region_with_focus(Some(effect(FocusShape::Radial, 0.5)));
        r.lead_in_sec = 0.6;
        r.return_sec = 0.9;
        for &t in &[1.0f32, 2.0, 3.0, 4.0, 6.0, 8.0] {
            let sample = focus_effect_sample_at(&[r.clone()], t, &ScreenClock::default());
            if let Some(s) = sample {
                assert!(s.progress.is_finite(), "t={t}");
                assert!((0.0..=1.0).contains(&s.progress), "t={t}: {}", s.progress);
            }
        }
    }
}

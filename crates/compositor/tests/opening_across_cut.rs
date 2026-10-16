//! L'ouverture se joue sur l'horloge de SORTIE, et cette horloge est continue à travers les
//! coupes. Ce fichier le prouve avec les DEUX sources de temps réelles, pas avec une constante
//! choisie dans le test :
//!
//!   - `Player::programme_time()` (preview) = `ProgrammeClock::at(source_sec)`, qui compte les
//!     frames de sortie de tous les clips PRÉCÉDENTS ;
//!   - `timeline_walk` (export) = `frames / out_fps`, un compteur global qui ne se remet pas à
//!     zéro à une coupe ;
//!   - `FrameGeometryInput::programme_time` — la SEULE valeur que lit `plan_frame`.
//!
//! Les trois premiers tests passent par `plan_frame` et couvrent ce que les tests unitaires de
//! `opening.rs` ne peuvent pas dire : que la géométrie s'applique VRAIMENT, qu'elle se compose
//! avec une région de zoom au lieu de la remplacer, que la frame précédente porte la même
//! transformation (sinon le flou de mouvement traîne sur toute l'entrée), et que Converge part
//! bien des deux coins opposés. Le dernier est le seul à avoir besoin d'un GPU et d'une source.
//!
//! Le piège que ce fichier existe pour attraper : `nativeSync.programmeTimeSec()` côté renderer
//! n'est PAS cette horloge. C'est un temps d'affichage pour la tête de lecture ; le natif a la
//! sienne, et c'est la seule qui compte ici. Un test bâti sur la première ne toucherait jamais
//! `plan_frame`.
//!
//! Programme de l'audit :
//!
//!     clip 0 — source 3..4 s  → sortie 0..1 s
//!     clip 1 — source 0..5 s  → sortie 1..6 s
//!
//! Les deux fenêtres source ne se touchent pas (3..4 puis 0..5, donc une discontinuité) : c'est
//! ce qui interdit à l'app de les fusionner en un seul clip, et ce qui rend un redémarrage
//! détectable. À la sortie 1,1 s on est dans le clip 1 à la source 0,1 s. Si l'ouverture lisait
//! le temps source elle repartirait de 0,1 / 4 = 2,5 % ; elle doit être à 1,1 / 4.

use openscreen_compositor::config::{self, Cfg};
use openscreen_compositor::frame_geometry::{live_params_from_scene, plan_frame, FrameGeometryInput};
use openscreen_compositor::opening::OpeningSequence;
use openscreen_compositor::scene::{Scene, SceneOpening};

#[cfg(windows)]
use openscreen_compositor::compositor::Compositor;
#[cfg(windows)]
use openscreen_compositor::d3d::Gpu;
#[cfg(windows)]
use openscreen_compositor::live::Player;

/// L'ouverture de l'audit : 4 s au total, 0,5 s entre les deux éléments, écran d'abord.
///
/// Volontairement plus longue et plus étalée que le défaut (2,2 / 0,16) : c'est ce qui rend la
/// différence entre « la suite » et « un redémarrage » visible à l'œil comme au chiffre.
fn audit_opening() -> OpeningSequence {
    let mut raw = SceneOpening::default();
    raw.enabled = true;
    raw.duration_sec = 4.0;
    raw.stagger_sec = 0.5;
    OpeningSequence::repaired(&raw)
}

/// Scène à un clip, avec ou sans l'ouverture, pour la partie géométrie.
fn geometry_scene_json(with_opening: bool) -> String {
    geometry_scene(with_opening, false, "sideSlide")
}

/// La même scène, avec un mouvement d'écran et/ou de caméra.
///
/// Les cibles sont volontairement LOIN du placement de base (position 0.25/0.25, échelle 1.4,
/// rotation 15°, taille caméra 1.8) : si l'ouverture écrasait le résultat du mouvement au lieu de
/// s'y composer, les assertions de fin le verraient immédiatement — une cible laissée au défaut
/// (0.5/0.5, échelle 1) ne prouverait rien, puisque c'est aussi ce que rend une ouverture posée.
fn motion_scene(with_opening: bool, preset: &str, screen_motion: &str, camera_motion: &str) -> String {
    let opening = if with_opening {
        format!(
            r#",
        "opening": {{"enabled":true,"preset":"{preset}","durationSec":4.0,"staggerSec":0.5,"curve":"swift","elementOrder":["screen","camera"],"includedElements":["screen","camera"]}}"#
        )
    } else {
        String::new()
    };
    format!(
        r##"{{
        "clips": [{{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":30,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"picture-in-picture","webcamSize":0.44,"webcamShape":"circle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0.0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [],
        "screenMotionRegions": {screen_motion},
        "cameraMotionRegions": {camera_motion},
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":1920,"height":1080,"fps":60}}{opening}
    }}"##
    )
}

/// Une région de mouvement d'écran qui déplace, agrandit ET fait tourner la carte.
const SCREEN_MOTION: &str = r#"[{"clipIndex":0,"startSec":0.0,"endSec":30.0,"target":{"positionX":0.25,"positionY":0.25,"scale":1.4,"rotationX":0.0,"rotationY":0.0,"rotationZ":15.0,"perspective":0.0},"easing":"linear"}]"#;

/// Une région de mouvement de caméra qui déplace ET agrandit la vignette.
const CAMERA_MOTION: &str = r#"[{"clipIndex":0,"startSec":0.0,"endSec":30.0,"target":{"positionX":0.25,"positionY":0.25,"size":1.8,"aspectRatio":1.0,"cornerFraction":1.0,"fullscreenProgress":0.0,"opacity":1.0},"easing":"linear"}]"#;


/// La même, avec une région de zoom et/ou un autre preset. Le zoom est ce qui permet de
/// vérifier que l'ouverture se COMPOSE avec la mise en page au lieu de la remplacer.
fn geometry_scene(with_opening: bool, with_zoom: bool, preset: &str) -> String {
    let opening = if with_opening {
        format!(
            r#",
        "opening": {{"enabled":true,"preset":"{preset}","durationSec":4.0,"staggerSec":0.5,"curve":"swift","elementOrder":["screen","camera"],"includedElements":["screen","camera"]}}"#
        )
    } else {
        String::new()
    };
    let zoom = if with_zoom {
        r#"[{"clipIndex":0,"startSec":0.0,"endSec":30.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"none"}]"#
    } else {
        "[]"
    };
    format!(
        r##"{{
        "clips": [{{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":30,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"picture-in-picture","webcamSize":0.44,"webcamShape":"circle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0.0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": {zoom},
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":1920,"height":1080,"fps":60}}{opening}
    }}"##
    )
}

/// Le programme de l'audit : deux clips dont les fenêtres source ne se touchent pas.
#[cfg(windows)]
fn two_clip_json(source: &str) -> String {
    let s = source.replace('\\', "/");
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":3,"sourceEndSec":4,"webcamOffsetSec":0,"hasAudio":false}},
                  {{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":5,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null, null],
        "output": {{"width":480,"height":270,"fps":60}},
        "opening": {{"enabled":true,"preset":"sideSlide","durationSec":4.0,"staggerSec":0.5,"curve":"swift","elementOrder":["screen","camera"],"includedElements":["screen","camera"]}}
    }}"##
    )
}

/// `frame` et `timeline_t_override` sont FIXES : seul `programme_time` bouge d'un appel à
/// l'autre. Sinon un déplacement des rects pourrait venir d'ailleurs que de l'ouverture.
fn input<'a>(scene: &'a Scene, cfg: &'a Cfg, programme_t: f32) -> FrameGeometryInput<'a> {
    FrameGeometryInput {
        render_px: [1920.0, 1080.0],
        screen_tex_px: [1920.0, 1088.0],
        screen_visible_px: [1920.0, 1080.0],
        webcam_visible_px: [1280.0, 720.0],
        u_max: 1.0,
        v_max: 1080.0 / 1088.0,
        frame: 0.0,
        cfg,
        live: live_params_from_scene(scene),
        scene: Some(scene),
        cursor: None,
        timeline_t_override: Some(0.0),
        programme_time: Some(programme_t),
    }
}

/// Même chose, mais le temps SOURCE avance aussi.
///
/// Indispensable pour les tests de composition : les mouvements d'écran et de caméra se lisent
/// sur le temps SOURCE (`source_t`), donc avec `timeline_t_override` figé à 0 ils resteraient au
/// départ de leur enveloppe — c'est-à-dire sans effet — et le test « la cible est intacte »
/// passerait pour de très mauvaises raisons : deux images identiques parce que rien n'a bougé.
fn input_moving<'a>(scene: &'a Scene, cfg: &'a Cfg, t: f32) -> FrameGeometryInput<'a> {
    FrameGeometryInput {
        timeline_t_override: Some(t),
        ..input(scene, cfg, t)
    }
}

/// Partie géométrie : pure, sans GPU, sans source vidéo — elle tourne partout.
///
/// Elle établit que `plan_frame` avance sur `programme_time` et se pose EXACTEMENT sur le
/// rect de repos à la fin, puis que la valeur qu'un redémarrage produirait (le temps source
/// 0,1 s du clip 1) donnerait une image toute différente.
#[test]
fn the_opening_advances_on_the_programme_clock_and_lands_exactly_home() {
    let cfg = config::all().pop().expect("au moins une config");
    let off = Scene::from_json(&geometry_scene_json(false)).expect("scène sans ouverture");
    let on = Scene::from_json(&geometry_scene_json(true)).expect("scène avec ouverture");

    let rect = |s: &Scene, t: f32| {
        let g = plan_frame(&input(s, &cfg, t));
        (g.s_dst, g.w_dst)
    };

    let (rest_screen, rest_cam) = rect(&off, 0.0);

    // Fin de l'ouverture : les rects sont EXACTEMENT ceux du repos, pas « à peu près ».
    // C'est `opening_rect` qui renvoie `base` tel quel à `eased >= 1.0` qui le garantit.
    assert_eq!(
        rect(&on, 4.0),
        (rest_screen, rest_cam),
        "à 4 s l'ouverture doit rendre la mise en page d'origine, au bit près"
    );
    // Et rien ne bouge après.
    assert_eq!(rect(&on, 5.0), rect(&on, 4.0), "après la durée, plus rien ne doit bouger");

    // Décalage latéral par rapport au repos. L'écran vient de la GAUCHE (négatif), la caméra
    // de la DROITE (positif).
    let offset = |t: f32| {
        let (s, w) = rect(&on, t);
        (s[0] - rest_screen[0], w[0] - rest_cam[0])
    };

    let (s_000, w_000) = offset(0.0);
    let (s_090, w_090) = offset(0.9);
    let (s_110, w_110) = offset(1.1);
    // Ce que l'horloge SOURCE produirait : la sortie 1,1 s est la source 0,1 s du clip 1.
    let (s_src, w_src) = offset(0.1);

    // L'écran approche de sa place, sans l'atteindre à 1,1 s.
    assert!(s_000 < s_090, "écran : 0 s plus loin que 0,9 s ({s_000} vs {s_090})");
    assert!(s_090 < s_110, "écran : 0,9 s plus loin que 1,1 s ({s_090} vs {s_110})");
    assert!(s_110 < 0.0, "écran : pas encore arrivé à 1,1 s ({s_110})");
    // À 0 s il est ENTIÈREMENT hors champ (une largeur de cadre + la sienne).
    assert!(s_000 <= -1.0, "écran : doit démarrer hors champ ({s_000})");

    // La caméra suit le même sens, décalée de `stagger`.
    assert!(w_000 > w_090, "caméra : 0 s plus loin que 0,9 s ({w_000} vs {w_090})");
    assert!(w_090 > w_110, "caméra : 0,9 s plus loin que 1,1 s ({w_090} vs {w_110})");
    assert!(w_110 > 0.0, "caméra : pas encore arrivée à 1,1 s ({w_110})");

    // ★ Le cœur de l'audit. À la sortie 1,1 s la vraie image doit être au moins DEUX FOIS plus
    // avancée que ce qu'un redémarrage sur le temps source (0,1 s) produirait. Un redémarrage
    // rendrait `s_110 == s_src`, donc ce rapport vaudrait 1.
    let ratio = s_110 / s_src;
    assert!(
        ratio < 0.5,
        "écran : la sortie 1,1 s ne doit pas ressembler au temps source 0,1 s (rapport {ratio})"
    );
    // La caméra est le témoin le plus net : à la source 0,1 s elle n'est PAS ENCORE ENTRÉE
    // (0,1 < stagger 0,5), donc un redémarrage la laisserait hors champ.
    assert_eq!(w_src, w_000, "garde : la source 0,1 s doit laisser la caméra au départ");
    assert!(
        w_110 < 0.5 * w_000,
        "caméra : à la sortie 1,1 s elle doit être à mi-parcours, pas au départ ({w_110} vs {w_000})"
    );
}

/// Converge, à travers `plan_frame`. Les deux éléments partent de coins OPPOSÉS — l'écran en
/// haut à gauche, la caméra en bas à droite — et se posent exactement comme en Side Slide.
#[test]
fn converge_starts_in_opposite_corners_and_lands_home() {
    let cfg = config::all().pop().expect("au moins une config");
    let off = Scene::from_json(&geometry_scene(false, false, "sideSlide")).expect("sans ouverture");
    let on = Scene::from_json(&geometry_scene(true, false, "converge")).expect("converge");

    let rect = |s: &Scene, t: f32| {
        let g = plan_frame(&input(s, &cfg, t));
        (g.s_dst, g.w_dst)
    };

    let (rest_screen, rest_cam) = rect(&off, 0.0);

    let (s0, c0) = rect(&on, 0.0);
    // L'écran sort par le coin HAUT-GAUCHE : hors cadre à gauche, et son haut est au-dessus.
    assert!(s0[0] + s0[2] <= 0.0, "écran : doit démarrer hors cadre à gauche ({s0:?})");
    assert!(s0[1] < 0.0, "écran : doit démarrer au-dessus du cadre ({s0:?})");
    assert!(s0[2] < rest_screen[2], "écran : doit démarrer plus petit ({s0:?})");
    // La caméra sort par le coin BAS-DROIT : les DEUX axes sont de l'autre côté.
    assert!(c0[0] >= 1.0, "caméra : doit démarrer hors cadre à droite ({c0:?})");
    assert!(c0[1] >= 1.0, "caméra : doit démarrer sous le cadre ({c0:?})");
    assert!(c0[2] < rest_cam[2], "caméra : doit démarrer plus petite ({c0:?})");

    // Les deux se rapprochent, sans jamais reculer.
    let mut prev_s = f32::NEG_INFINITY;
    let mut prev_c_x = f32::INFINITY;
    let mut prev_c_y = f32::INFINITY;
    for t in [0.0_f32, 0.5, 1.0, 1.5, 2.2, 3.0] {
        let (s, c) = rect(&on, t);
        assert!(s[0] >= prev_s - 1e-6, "écran : recule à t={t} ({s:?})");
        assert!(c[0] <= prev_c_x + 1e-6, "caméra : avance à t={t} ({c:?})");
        assert!(c[1] <= prev_c_y + 1e-6, "caméra : remonte à t={t} ({c:?})");
        prev_s = s[0];
        prev_c_x = c[0];
        prev_c_y = c[1];
    }

    // Fin : exactement la mise en page de repos, comme en Side Slide.
    assert_eq!(rect(&on, 4.0), (rest_screen, rest_cam), "à 4 s converge doit être posé");
    assert_eq!(rect(&on, 5.0), rect(&on, 4.0), "après la durée, plus rien ne bouge");
}

/// L'ouverture est une transformation PAR-DESSUS la mise en page, jamais un remplacement :
/// une région de zoom doit survivre, et être rendue telle quelle une fois l'ouverture finie.
#[test]
fn the_opening_composes_with_a_zoom_region_instead_of_replacing_it() {
    let cfg = config::all().pop().expect("au moins une config");
    let zoom_off = Scene::from_json(&geometry_scene(false, true, "sideSlide")).expect("zoom seul");
    let zoom_on = Scene::from_json(&geometry_scene(true, true, "sideSlide")).expect("zoom + ouverture");
    let no_zoom_off =
        Scene::from_json(&geometry_scene(false, false, "sideSlide")).expect("sans zoom");

    let rect = |s: &Scene, t: f32| {
        let g = plan_frame(&input(s, &cfg, t));
        (g.s_dst, g.w_dst)
    };

    // Le zoom est bien réel : sa mise en page diffère de celle sans zoom.
    assert_ne!(
        rect(&zoom_off, 1.0),
        rect(&no_zoom_off, 1.0),
        "garde : la scène zoomée doit différer de la scène sans zoom"
    );

    // Passé la durée, l'ouverture rend EXACTEMENT la mise en page zoomée : la cible de
    // l'utilisateur n'est pas écrasée, elle est seulement déplacée pendant l'entrée.
    assert_eq!(
        rect(&zoom_on, 4.0),
        rect(&zoom_off, 4.0),
        "à 4 s l'ouverture doit rendre la mise en page zoomée telle quelle"
    );
    assert_eq!(rect(&zoom_on, 5.0), rect(&zoom_off, 5.0), "et ne plus rien changer après");

    // Pendant l'entrée, elle s'ajoute au zoom : ni l'un ni l'autre n'a disparu.
    let during = rect(&zoom_on, 0.5);
    assert_ne!(during, rect(&zoom_off, 0.5), "l'ouverture doit bien déplacer la vue zoomée");
    assert_ne!(during, rect(&no_zoom_off, 0.5), "et le zoom doit rester appliqué pendant");
}

/// La frame PRÉCÉDENTE porte la même transformation, un pas plus tôt. Sans ça le flou de
/// mouvement part de la position d'arrivée et la traînée fait toute la largeur du cadre.
#[test]
fn the_previous_frame_carries_the_same_opening_transform() {
    let cfg = config::all().pop().expect("au moins une config");
    let off = Scene::from_json(&geometry_scene(false, false, "sideSlide")).expect("sans ouverture");
    let on = Scene::from_json(&geometry_scene(true, false, "sideSlide")).expect("avec ouverture");

    let g = |s: &Scene, t: f32| plan_frame(&input(s, &cfg, t));

    // Repère : une mise en page immobile n'a AUCUNE traînée (`prev == now`).
    let still = g(&off, 1.0);
    assert_eq!(still.s_dst, still.s_dst_prev, "garde : sans mouvement, pas de traînée");

    // Pendant l'entrée, il y a bien un mouvement d'une frame...
    let moving = g(&on, 1.0);
    let dx = (moving.s_dst[0] - moving.s_dst_prev[0]).abs();
    assert!(dx > 0.0, "l'écran doit bouger d'une frame à l'autre pendant l'entrée");

    // ...et il vaut la distance parcourue en UNE frame, pas la largeur du cadre. La traînée
    // d'un Side Slide à mi-vol fait ~0,007 du cadre ; une `prev` restée à la position
    // d'arrivée en ferait ~0,10, soit quinze fois plus.
    assert!(
        dx < 0.02,
        "la traînée doit couvrir une frame, pas toute l'entrée (dx = {dx})"
    );

    // La caméra aussi : sa `prev` doit être en vol, pas posée.
    let dcam = (moving.w_dst[1] - moving.w_dst_prev[1]).abs();
    assert!(dcam > 0.0, "la caméra doit bouger d'une frame à l'autre pendant l'entrée");
    assert!(dcam < 0.02, "traînée caméra hors de l'échelle d'une frame (dy = {dcam})");

    // Et une fois l'ouverture finie, plus aucune traînée : `prev == now` à nouveau.
    let settled = g(&on, 4.0);
    assert_eq!(settled.s_dst, settled.s_dst_prev, "après l'ouverture, plus de traînée d'écran");
    assert_eq!(settled.w_dst, settled.w_dst_prev, "après l'ouverture, plus de traînée caméra");
}

/// Converge + Screen Motion, en même temps, sur le même écran.
///
/// L'ouverture est appliquée APRÈS le mouvement d'écran, sur la boîte que le mouvement a déjà
/// posée. Ce test vérifie les deux moitiés de cette phrase : que le mouvement participe bien
/// (position, échelle ET rotation) pendant l'entrée, et qu'une fois l'ouverture finie c'est la
/// cible du mouvement qu'on retrouve — pas la mise en page de base. La cible est délibérément
/// loin du placement par défaut, sinon les deux seraient confondues et le test ne dirait rien.
#[test]
fn converge_composes_with_screen_motion_instead_of_overriding_it() {
    let cfg = config::all().pop().expect("au moins une config");
    let plain_off = Scene::from_json(&motion_scene(false, "converge", "[]", "[]")).expect("nu");
    let moved_off =
        Scene::from_json(&motion_scene(false, "converge", SCREEN_MOTION, "[]")).expect("mouvement");
    let moved_on =
        Scene::from_json(&motion_scene(true, "converge", SCREEN_MOTION, "[]")).expect("mouvement + ouverture");
    let plain_on =
        Scene::from_json(&motion_scene(true, "converge", "[]", "[]")).expect("ouverture seule");

    let g = |s: &Scene, t: f32| plan_frame(&input_moving(s, &cfg, t));
    let rect = |s: &Scene, t: f32| g(s, t).s_dst;

    // (1a) Le mouvement d'écran PARTICIPE : sa boîte n'est pas celle du placement de base.
    let moved = rect(&moved_off, 3.0);
    let base = rect(&plain_off, 3.0);
    assert_ne!(moved, base, "garde : le mouvement d'écran doit déplacer la carte");
    // Position ET échelle : la cible met la carte à 0,25/0,25 et ×1,4, donc sa boîte change de
    // centre et de taille, pas seulement de place.
    assert!(
        (moved[2] - base[2]).abs() > 0.01,
        "garde : l'échelle du mouvement doit s'appliquer ({moved:?} vs {base:?})"
    );
    // (1b) ...et la ROTATION aussi. Elle ne vit pas dans la boîte (qui reste alignée sur les axes)
    // mais dans `zoom_rotation`, où le mouvement d'écran l'AJOUTE à celle du zoom.
    assert!(
        g(&moved_off, 3.0).zoom_rotation != [0.0, 0.0, 0.0],
        "garde : la rotation du mouvement d'écran doit être portée par zoom_rotation"
    );

    // (2) Pendant l'entrée, les DEUX sont appliqués : retirer l'un OU l'autre change l'image.
    let during = rect(&moved_on, 1.0);
    assert_ne!(during, rect(&moved_off, 1.0), "l'ouverture doit déplacer la carte animée");
    assert_ne!(during, rect(&plain_on, 1.0), "le mouvement doit rester appliqué pendant l'entrée");
    // La rotation, elle, n'est PAS touchée par l'ouverture : elle est la même avec et sans.
    assert_eq!(
        g(&moved_on, 1.0).zoom_rotation,
        g(&moved_off, 1.0).zoom_rotation,
        "l'ouverture ne doit pas toucher à la rotation du mouvement"
    );

    // (3) Après l'ouverture : EXACTEMENT la mise en page du mouvement, pas celle de base. C'est ce
    // que veut dire « ne pas écraser la cible » — et la cible elle-même n'a jamais été écrite, la
    // scène est lue en `&Scene`, donc rien n'a pu la modifier.
    for t in [4.0_f32, 5.0, 12.0] {
        assert_eq!(
            (rect(&moved_on, t), g(&moved_on, t).zoom_rotation),
            (rect(&moved_off, t), g(&moved_off, t).zoom_rotation),
            "à t={t} la cible du mouvement d'écran doit être intacte"
        );
    }
    assert_ne!(
        rect(&moved_on, 5.0),
        base,
        "la cible n'est pas retombée sur la mise en page de base"
    );
}

/// Converge + Camera Motion : même contrat, sur la vignette caméra.
#[test]
fn converge_composes_with_camera_motion_instead_of_overriding_it() {
    let cfg = config::all().pop().expect("au moins une config");
    let plain_off = Scene::from_json(&motion_scene(false, "converge", "[]", "[]")).expect("nu");
    let moved_off =
        Scene::from_json(&motion_scene(false, "converge", "[]", CAMERA_MOTION)).expect("mouvement");
    let moved_on =
        Scene::from_json(&motion_scene(true, "converge", "[]", CAMERA_MOTION)).expect("mouvement + ouverture");
    let plain_on =
        Scene::from_json(&motion_scene(true, "converge", "[]", "[]")).expect("ouverture seule");

    let cam = |s: &Scene, t: f32| plan_frame(&input_moving(s, &cfg, t)).w_dst;

    // (1) Le mouvement de caméra PARTICIPE : position et taille.
    let moved = cam(&moved_off, 3.0);
    let base = cam(&plain_off, 3.0);
    assert_ne!(moved, base, "garde : le mouvement de caméra doit déplacer la vignette");
    assert!(
        (moved[2] - base[2]).abs() > 0.01,
        "garde : la taille du mouvement de caméra doit s'appliquer ({moved:?} vs {base:?})"
    );

    // (2) Pendant l'entrée, l'ouverture s'ajoute au mouvement de caméra.
    assert_ne!(cam(&moved_on, 1.0), cam(&moved_off, 1.0), "l'ouverture doit déplacer la vignette animée");
    assert_ne!(cam(&moved_on, 1.0), cam(&plain_on, 1.0), "le mouvement doit rester appliqué");

    // (3) Après : la cible du mouvement, telle quelle.
    for t in [4.0_f32, 5.0, 12.0] {
        assert_eq!(
            cam(&moved_on, t),
            cam(&moved_off, t),
            "à t={t} la cible du mouvement de caméra doit être intacte"
        );
    }
    assert_ne!(cam(&moved_on, 5.0), base, "la cible n'est pas retombée sur la mise en page de base");
}

/// Partie horloge : le VRAI `ProgrammeClock` de la preview, sur une vraie source décodée.
///
/// La CI ne la joue pas (il faut D3D11 et une source), comme `programme_time_seek.rs` :
///
/// ```powershell
/// $env:OPENSCREEN_PRIVACY_SECRET = "...\n'importe quel mp4 d'au moins 6 s"
/// cargo test -p openscreen-compositor --test opening_across_cut -- --nocapture
/// ```
#[cfg(windows)]
#[test]
fn the_real_programme_clock_carries_clip_zero_into_clip_one() {
    let Ok(source) = std::env::var("OPENSCREEN_PRIVACY_SECRET") else {
        println!("SKIP: definir OPENSCREEN_PRIVACY_SECRET (voir l'en-tete du fichier).");
        return;
    };
    let gpu = Gpu::create(false).expect("device d3d11");
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(&gpu, 480, 270).expect("compositor");
    let scene = Scene::from_json(&two_clip_json(&source)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene.clone()));
    comp.clear_cursor();

    let opening = audit_opening();

    unsafe {
        let mut player = Player::open(&source, "", &gpu).expect("ouvrir la source");

        // ---- Clip 0 : la sortie commence à 0, la source à 3 s.
        player.set_programme_clock(Some(&scene), 0);
        assert!(player.present_frame(&comp, &cfg, 3.9).expect("seek clip 0"));
        // `screen_time_sec()` rend le pts ABSOLU du décodeur, pas le temps du clip : ici
        // 3,9 s de source, dont il faut retirer les 3 s de départ du clip 0.
        let screen_0 = player.screen_time_sec();
        let programme_0 = comp.programme_time().expect("clip 0 : temps programme non transmis");
        println!("clip 0 : source {screen_0} s -> programme {programme_0} s");
        // Le clip 0 est le PREMIER : 0 s de sortie avant lui, donc programme = source - 3.
        assert!(
            (programme_0 as f64 - (screen_0 - 3.0)).abs() < 1e-4,
            "clip 0 : programme {programme_0} != source {screen_0} - 3 s (debut du clip)"
        );

        // ---- Clip 1 : la sortie commence à 1 s, la source à 0 s.
        player.set_programme_clock(Some(&scene), 1);
        assert!(player.present_frame(&comp, &cfg, 0.1).expect("seek clip 1"));
        // Ici le clip commence à la source 0, donc pts absolu == temps source du clip. C'est
        // une coïncidence de ce programme-là, et elle est voulue : elle rend « le temps source »
        // et « le temps du clip » indiscernables, donc l'erreur que ce test traque est
        // exactement celle qu'un lecteur pressé commettrait.
        let screen_1 = player.screen_time_sec();
        let programme_1 = comp.programme_time().expect("clip 1 : temps programme non transmis");

        println!("clip 1 : source {screen_1} s -> programme {programme_1} s");

        // ★ L'horloge compte la SORTIE du clip 0 (1 s) PUIS le temps source du clip 1.
        assert!(
            (programme_1 as f64 - (1.0 + screen_1)).abs() < 1e-4,
            "clip 1 : programme {programme_1} != 1 s (sortie du clip 0) + source {screen_1}"
        );
        // Et surtout : ce n'est PAS le temps source. C'est exactement l'erreur que
        // l'ouverture aurait faite en lisant `source_t`.
        assert!(
            (programme_1 as f64 - screen_1).abs() > 0.9,
            "clip 1 : le temps programme est retombe sur le temps source ({programme_1} vs {screen_1})"
        );
        // La source est bien celle demandée (à une frame source près).
        assert!(
            (screen_1 - 0.1).abs() < 0.1,
            "clip 1 : seek a 0,1 s tombe sur {screen_1} s"
        );

        // ---- Le lien : ce que la géométrie fait de cette horloge.
        let eased_at_programme = opening
            .sample_at(programme_1, true)
            .screen
            .expect("ecran present")
            .eased;
        let eased_if_restarted = opening
            .sample_at(screen_1 as f32, true)
            .screen
            .expect("ecran present")
            .eased;
        println!(
            "ecran : programme -> eased {eased_at_programme}, source (redemarrage) -> eased {eased_if_restarted}"
        );
        assert!(
            eased_at_programme > 0.7,
            "a 1,1 s l'ouverture doit etre largement entamee ({eased_at_programme})"
        );
        assert!(
            eased_if_restarted < 0.2,
            "le temps source donnerait un redemarrage ({eased_if_restarted})"
        );
        // Le temoin le plus net : a la source 0,1 s la camera n'est pas encore entree.
        assert_eq!(
            opening.sample_at(screen_1 as f32, true).camera.map(|c| c.eased),
            Some(0.0),
            "garde : la source 0,1 s laisse la camera au depart"
        );
        let cam_at_programme = opening
            .sample_at(programme_1, true)
            .camera
            .expect("camera presente")
            .eased;
        assert!(
            cam_at_programme > 0.0,
            "a 1,1 s la camera doit deja etre entree ({cam_at_programme})"
        );

        // ---- Fin : passe 4 s, les deux elements sont poses.
        let at_end = opening.sample_at(4.0, true);
        assert_eq!(at_end.screen.expect("ecran").eased, 1.0, "a 4 s l'ecran est pose");
        assert_eq!(at_end.camera.expect("camera").eased, 1.0, "a 4 s la camera est posee");
    }
}

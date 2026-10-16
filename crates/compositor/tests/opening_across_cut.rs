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

// ── Light 3D ─────────────────────────────────────────────────────────────────

/// Longueur d'une arête, en px.
fn edge_len(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Light 3D doit produire une VRAIE projection : le quad de `screen_tilt` est un trapèze, pas un
/// rectangle.
///
/// C'est le seul contrôle qui distingue « projection 3D » de « mise à l'échelle + translation
/// déguisées » : une transformation 2D quelconque garde les arêtes opposées parallèles et de même
/// longueur, donc le haut et le bas restent égaux. Sous une perspective finie avec tangage et
/// lacet, le côté proche est plus grand que le côté loin, et l'écart se mesure en dizaines de px.
#[test]
fn light3d_really_projects_a_trapezoid() {
    let cfg = config::all().pop().expect("au moins une config");
    let off = Scene::from_json(&motion_scene(false, "light3D", "[]", "[]")).expect("sans ouverture");
    let on = Scene::from_json(&motion_scene(true, "light3D", "[]", "[]")).expect("light3d");

    let cfg_ref = &cfg;
    let quad = |s: &Scene, t: f32| {
        let g = plan_frame(&input_moving(s, cfg_ref, t));
        let s_px = [g.s_dst[2] * 1920.0, g.s_dst[3] * 1080.0];
        (g.tilted(), g.screen_tilt(s_px))
    };

    // Au repos il n'y a AUCUNE inclinaison : c'est ce qui garantit qu'un écran posé reste plat.
    assert!(!quad(&off, 0.0).0, "garde : sans ouverture l'écran ne doit pas être incliné");
    let (tilted_at_rest, rest_quad) = quad(&on, 4.0);
    assert!(!tilted_at_rest, "à 4 s l'ouverture doit rendre un écran PLAT, pas « presque plat »");
    assert!(rest_quad.is_none(), "et aucun quad incliné ne doit être produit");

    // En vol, l'inclinaison existe et le quad est un vrai trapèze.
    for t in [0.25_f32, 0.5, 1.0, 1.5] {
        let (tilted, maybe) = quad(&on, t);
        assert!(tilted, "à t={t} l'écran doit être incliné");
        let q = maybe.expect("un quad incliné doit être produit");
        assert_ne!(q.rot, [0.0; 3], "les angles doivent être RÉELLEMENT dessinés à t={t}");
        assert!(q.perspective > 0.0, "une perspective finie doit être en jeu à t={t}");

        let c = q.corners;
        let (top, bottom) = (edge_len(c[0], c[1]), edge_len(c[3], c[2]));
        let (left, right) = (edge_len(c[0], c[3]), edge_len(c[1], c[2]));
        // Un rectangle (donc toute transformation 2D) a haut == bas et gauche == droite.
        assert!(
            (top - bottom).abs() > 20.0,
            "à t={t} le haut et le bas doivent différer — sinon ce n'est qu'un 2D (haut {top}, bas {bottom})"
        );
        assert!(
            (left - right).abs() > 5.0,
            "à t={t} la gauche et la droite doivent différer (gauche {left}, droite {right})"
        );
        // Et les angles dessinés sont bien ceux annoncés, pas une autre pose.
        let want = expected_screen_angles(t);
        assert!(
            (q.rot[0] - want[0]).abs() < 0.01 && (q.rot[1] - want[1]).abs() < 0.01,
            "à t={t} : angles dessinés {:?}, attendus {want:?}",
            q.rot
        );
    }
}

/// Les angles que le preset doit produire à `t`, en degrés : `swift_ease` porte la position et
/// l'échelle, la progression LINÉAIRE porte les angles (durée 4 s, décalage 0,5 s, écran premier).
fn expected_screen_angles(t: f32) -> [f32; 2] {
    let linear = (t / (4.0 - 0.5)).clamp(0.0, 1.0);
    let remaining = (1.0 - linear).powf(1.5);
    [9.0 * remaining, -22.0 * remaining]
}

/// Le zoom de `geometry_scene`, mais AVEC sa rotation `left` (-12°, -18°, -2°).
///
/// Il en faut une : une scène dont la rotation existante est nulle ne peut pas distinguer
/// « l'ouverture s'ajoute » de « l'ouverture remplace », puisque les deux donnent le même résultat.
fn zoomed_rotated_scene(with_opening: bool, preset: &str) -> String {
    geometry_scene(with_opening, true, preset).replace(r#""rotation":"none""#, r#""rotation":"left""#)
}

/// Light 3D s'AJOUTE à la rotation du zoom et des mouvements d'écran, il ne la remplace pas.
#[test]
fn light3d_composes_with_zoom_and_screen_motion() {
    let cfg = config::all().pop().expect("au moins une config");
    let zoom_off = Scene::from_json(&zoomed_rotated_scene(false, "light3D")).expect("zoom seul");
    let zoom_on = Scene::from_json(&zoomed_rotated_scene(true, "light3D")).expect("zoom + light3d");
    let motion_off =
        Scene::from_json(&motion_scene(false, "light3D", SCREEN_MOTION, "[]")).expect("mouvement seul");
    let motion_on =
        Scene::from_json(&motion_scene(true, "light3D", SCREEN_MOTION, "[]")).expect("mouvement + light3d");

    let g = |s: &Scene, t: f32| plan_frame(&input_moving(s, &cfg, t));

    // Zoom : la cible est intacte après l'ouverture, angles compris.
    for t in [4.0_f32, 5.0, 12.0] {
        let a = g(&zoom_on, t);
        let b = g(&zoom_off, t);
        assert_eq!((a.s_dst, a.zoom_rotation), (b.s_dst, b.zoom_rotation), "zoom à t={t}");
    }
    // Pendant le vol, les deux rotations coexistent : celle du zoom ET celle de l'ouverture.
    let zoom_rot_during = g(&zoom_on, 1.0).zoom_rotation;
    let zoom_rot_alone = g(&zoom_off, 1.0).zoom_rotation;
    assert_ne!(zoom_rot_during, zoom_rot_alone, "l'ouverture doit ajouter son angle");
    assert_ne!(zoom_rot_during, [0.0; 3], "et le zoom ne doit pas disparaître");

    // Mouvement d'écran : les deux contributions se somment axe par axe.
    for t in [4.0_f32, 5.0, 12.0] {
        let a = g(&motion_on, t);
        let b = g(&motion_off, t);
        assert_eq!((a.s_dst, a.zoom_rotation), (b.s_dst, b.zoom_rotation), "mouvement à t={t}");
    }
    let motion_rot = g(&motion_off, 1.0).zoom_rotation;
    assert_ne!(motion_rot, [0.0; 3], "garde : le mouvement d'écran doit déjà tourner");
    let both = g(&motion_on, 1.0).zoom_rotation;
    assert_ne!(both, motion_rot, "l'ouverture doit s'ajouter à la rotation du mouvement");
    // ...et la différence entre « avec » et « sans » ouverture EST exactement l'angle du preset.
    let want = expected_screen_angles(1.0);
    for axis in 0..2 {
        assert!(
            ((both[axis] - motion_rot[axis]) - want[axis]).abs() < 1e-3,
            "axe {axis} : la contribution de l'ouverture doit être {}°, obtenue {}°",
            want[axis],
            both[axis] - motion_rot[axis]
        );
    }
    // Même contrôle du côté du zoom, dans SA famille de scènes : la rotation de l'ouverture
    // s'ajoute à celle du zoom au lieu de la remplacer.
    let zoom_rot_alone = g(&zoom_off, 1.0).zoom_rotation;
    assert_ne!(zoom_rot_alone, [0.0; 3], "garde : le zoom doit déjà tourner");
    let zoom_with_opening = g(&zoom_on, 1.0).zoom_rotation;
    for axis in 0..2 {
        assert!(
            ((zoom_with_opening[axis] - zoom_rot_alone[axis]) - want[axis]).abs() < 1e-3,
            "axe {axis} : contribution de l'ouverture sur le zoom, obtenue {}°",
            zoom_with_opening[axis] - zoom_rot_alone[axis]
        );
    }
}

/// La rotation de la frame PRÉCÉDENTE suit celle de la frame courante, un pas plus tôt.
#[test]
fn light3d_previous_frame_rotation_is_in_step() {
    let cfg = config::all().pop().expect("au moins une config");
    let off = Scene::from_json(&motion_scene(false, "light3D", "[]", "[]")).expect("sans ouverture");
    let on = Scene::from_json(&motion_scene(true, "light3D", "[]", "[]")).expect("light3d");
    let g = |s: &Scene, t: f32| plan_frame(&input_moving(s, &cfg, t));

    // Repère : au repos, les deux rotations sont exactement nulles.
    let still = g(&off, 1.0);
    assert_eq!(still.zoom_rotation, [0.0; 3]);
    assert_eq!(still.zoom_rotation_prev, [0.0; 3]);

    // En vol : les deux existent, et l'angle d'avant est PLUS grand (il se décroît), d'un pas de
    // frame seulement. Une prev restée plate ferait un écart de tout l'angle.
    let moving = g(&on, 1.0);
    assert!(moving.zoom_rotation[0] > 0.0, "l'angle courant doit exister");
    assert!(
        moving.zoom_rotation_prev[0] > moving.zoom_rotation[0],
        "l'angle d'avant doit être plus ouvert ({:?} vs {:?})",
        moving.zoom_rotation_prev,
        moving.zoom_rotation
    );
    let delta = moving.zoom_rotation_prev[0] - moving.zoom_rotation[0];
    assert!(
        delta < 1.0,
        "l'écart doit couvrir UNE frame, pas toute l'entrée (écart = {delta}°, courant = {}°, prev = {}°)",
        moving.zoom_rotation[0],
        moving.zoom_rotation_prev[0]
    );

    // Après l'ouverture : exactement nul des deux côtés, plus aucun fantôme de rotation.
    let settled = g(&on, 4.0);
    assert_eq!(settled.zoom_rotation, [0.0; 3], "l'angle doit s'éteindre EXACTEMENT");
    assert_eq!(settled.zoom_rotation_prev, [0.0; 3]);
    assert!(!settled.tilted(), "et l'écran doit redevenir plat");
}

/// Un programme coupé en deux clips dont les fenêtres source ne se touchent pas ne rejoue PAS
/// l'ouverture au second clip, angles compris.
#[test]
fn light3d_does_not_restart_across_a_cut() {
    let cfg = config::all().pop().expect("au moins une config");
    let scene = Scene::from_json(&light3d_crosscut_scene()).expect("deux clips");
    let g = |t: f32| plan_frame(&input_moving(&scene, &cfg, t));

    // Durée 4 s : à la sortie 1,1 s, l'ouverture est à 1,1/3,5 de sa course.
    let linear = 1.1_f32 / 3.5;
    let remaining = (1.0 - linear).powf(1.5);
    let at_110 = g(1.1).zoom_rotation;
    assert!(
        (at_110[0] - 9.0 * remaining).abs() < 0.05,
        "attendu {}° pour un temps programme de 1,1 s, obtenu {:?}",
        9.0 * remaining,
        at_110
    );

    // Ce qu'un redémarrage sur le temps SOURCE du clip B (0,1212 s) produirait : l'angle serait
    // presque intact. L'écart est franc, donc la mesure tranche.
    let restart_linear = 0.1212_f32 / 3.5;
    let restart = 9.0 * (1.0 - restart_linear).powf(1.5);
    assert!(
        (at_110[0] - restart).abs() > 3.0,
        "angle mesuré {}° trop proche d'un redémarrage ({restart}°)",
        at_110[0]
    );

    // Et la mise en page, elle, tranche sans ambiguïté (cf. le test 4-B.1 équivalent).
    assert!(at_110[0] > 0.0 && at_110[0] < 9.0, "en vol, pas au départ ni posé");
}

/// Le rect de l'écran pour le programme à deux clips non contigus, en Light 3D.
fn light3d_crosscut_scene() -> String {
    geometry_scene(true, false, "light3D").replace(
        r#""clips": [{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":30,"webcamOffsetSec":0,"hasAudio":false}]"#,
        r#""clips": [{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":3,"sourceEndSec":4,"webcamOffsetSec":0,"hasAudio":false},{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":5,"webcamOffsetSec":0,"hasAudio":false}]"#,
    )
}

/// Rien n'est mémorisé : le même temps redonne le même état, dans n'importe quel ordre.
///
/// La scène de ce fichier a une ouverture de 4 s, donc 3,0 s et 2,5 s sont EN VOL (l'écran se
/// pose à 3,5 s) — l'assertion suit le modèle au lieu de supposer « 2,2 s comme le projet de
/// l'app ». Ce qui est testé ici, c'est la reproductibilité, pas un état particulier.
#[test]
fn light3d_seek_is_stateless() {
    let cfg = config::all().pop().expect("au moins une config");
    let on = Scene::from_json(&motion_scene(true, "light3D", "[]", "[]")).expect("light3d");
    let g = |t: f32| plan_frame(&input_moving(&on, &cfg, t));

    // Chaque temps rend EXACTEMENT l'angle du modèle — y compris après un saut.
    for t in [3.0_f32, 0.5, 2.5, 0.5, 3.0] {
        let got = g(t).zoom_rotation;
        let want = expected_screen_angles(t);
        assert!(
            (got[0] - want[0]).abs() < 1e-3 && (got[1] - want[1]).abs() < 1e-3,
            "à t={t} : obtenu {got:?}, attendu {want:?}"
        );
    }

    // 3,0 -> 0,5 -> 2,5 : trois sauts, sans avoir joué les frames intermédiaires.
    let a = (g(3.0).s_dst, g(3.0).zoom_rotation);
    let b = (g(0.5).s_dst, g(0.5).zoom_rotation);
    let c = (g(2.5).s_dst, g(2.5).zoom_rotation);
    assert!(b.1[1] < c.1[1], "à 0,5 s l'écran est plus de biais qu'à 2,5 s");
    assert!(c.1[1] < a.1[1], "à 2,5 s plus de biais qu'à 3,0 s");
    // Revenir en arrière redonne EXACTEMENT l'état d'avant, angle compris.
    assert_eq!((g(0.5).s_dst, g(0.5).zoom_rotation), b);
    assert_eq!((g(3.0).s_dst, g(3.0).zoom_rotation), a);
    // Et passé la durée, plus rien ne bouge : posé ET plat.
    assert_eq!(g(4.0).zoom_rotation, [0.0; 3]);
    assert_eq!(g(9.0).zoom_rotation, [0.0; 3]);
    assert_eq!(g(4.0).s_dst, g(9.0).s_dst);
}

/// Une scène zoomée dont la caméra 3D est en ORBITE — la seule valeur qui active une Camera Pose
/// réelle (`regions.rs`), et donc le seul chemin qui court-circuite les angles fixes.
fn orbited_scene(with_opening: bool) -> String {
    geometry_scene(with_opening, true, "light3D").replace(r#""rotation":"none""#, r#""rotation":"orbit""#)
}

/// Le point de conflit que ce tour devait trancher, CONSTATÉ au lieu d'être caché.
///
/// `screen_tilt()` rend le quad de la Camera Pose RÉELLE **avant** de regarder les angles fixes
/// (`if let Some(pose) = self.camera { return Some(camera::View::new(...).quad(...)) }`). Une
/// orbite de zoom active court-circuite donc l'inclinaison de Light 3D : l'angle est bien calculé
/// et bien présent dans `zoom_rotation`, mais il n'est pas DESSINÉ tant que l'orbite est là.
///
/// Stratégie retenue : ne rien casser. La pose de la caméra réelle est une homographie mesurée, et
/// la remplacer par des angles fixes ferait sauter l'écran à l'entrée en orbite. C'est donc
/// l'ouverture qui s'efface — et seulement son INCLINAISON : sa translation et son échelle
/// continuent de s'appliquer, l'écran entre bien, il entre à plat.
///
/// Ce test existe pour que la limite soit mesurée et datée, pas pour la justifier.
#[test]
fn a_real_camera_pose_wins_over_the_opening_rotation() {
    let cfg = config::all().pop().expect("au moins une config");
    let orbit_off = Scene::from_json(&orbited_scene(false)).expect("orbite seule");
    let orbit_on = Scene::from_json(&orbited_scene(true)).expect("orbite + light3d");

    let g = |s: &Scene, t: f32| {
        let fg = plan_frame(&input_moving(s, &cfg, t));
        let s_px = [fg.s_dst[2] * 1920.0, fg.s_dst[3] * 1080.0];
        (fg.s_dst, fg.zoom_rotation, fg.screen_tilt(s_px).map(|q| (q.rot, q.projective)))
    };

    // 1. L'angle du preset EST bien calculé et présent dans la géométrie.
    let during = g(&orbit_on, 1.0);
    assert!(
        during.1[1].abs() > 5.0,
        "l'angle du preset doit bien être dans zoom_rotation ({:?})",
        during.1
    );

    // 2. ...mais le quad RENDU est celui de la caméra, pas celui des angles fixes.
    let (quad_rot, projective) = during.2.expect("une pose réelle produit toujours un quad");
    assert!(
        (quad_rot[1] - during.1[1]).abs() > 1.0,
        "la pose réelle doit COURT-CIRCUITER l'angle fixe (quad {quad_rot:?} vs zoom_rotation {:?})",
        during.1
    );
    assert!(projective, "une pose réelle passe par l'homographie exacte, pas le warp bilinéaire");

    // 3. La translation et l'échelle, elles, s'appliquent quand même : l'écran entre.
    assert_ne!(during.0, g(&orbit_off, 1.0).0, "l'écran doit quand même entrer");

    // 4. L'orbite, de son côté, n'a rien perdu : passé l'ouverture, la scène est EXACTEMENT celle
    //    sans ouverture — pose, rotation et quad compris.
    for t in [4.0_f32, 5.0, 12.0] {
        let a = g(&orbit_on, t);
        let b = g(&orbit_off, t);
        assert_eq!((a.0, a.1), (b.0, b.1), "orbite à t={t}");
        assert_eq!(a.2, b.2, "quad d'orbite à t={t}");
    }

    // 5. Le témoin qui donne son sens au « ça ne s'incline pas » ci-dessus : SANS orbite, la même
    //    scène Light 3D produit bel et bien un quad incliné.
    let plain = Scene::from_json(&geometry_scene(true, true, "light3D")).expect("light3d");
    let fg = plan_frame(&input_moving(&plain, &cfg, 1.0));
    let plain_px = [fg.s_dst[2] * 1920.0, fg.s_dst[3] * 1080.0];
    assert!(
        fg.screen_tilt(plain_px).is_some(),
        "garde : sans orbite, Light 3D doit produire un quad incliné"
    );
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

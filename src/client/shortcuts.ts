import "./shortcuts.css";

type RowKind = "key" | "mouse" | "ui" | "mode" | "access";

interface BindingRow {
  binding?: string;
  action: string;
  note?: string;
  source: string;
  kind?: RowKind;
  wasdBinding?: string;
  classicBinding?: string;
}

interface SectionDef {
  id: string;
  kicker: string;
  title: string;
  desc: string;
  rows: BindingRow[];
  note?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Binding strings use backticks to mark key caps. Everything is hand-authored
// below after reading the live handlers; the source field and inline comments
// record the exact implementation lines checked while writing this page.
function appendBinding(parent: HTMLElement, text: string): void {
  const parts = text.split("`");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1) parent.append(el("kbd", "", part));
    else parent.append(document.createTextNode(part));
  }
}

const SECTIONS: SectionDef[] = [
  {
    id: "camera",
    kicker: "01 / BATTLEFIELD VIEW",
    title: "Camera & Navigation",
    desc: "Camera control works in both hotkey modes. The only difference is whether WASD pans the camera or is released for classic RTS command hotkeys.",
    rows: [
      // input.ts:1291-1297 — arrows always pan; WASD is added only while wasdPan is true.
      {
        action: "Pan camera",
        note: "Default WASD mode uses both WASD and arrows. Classic mode uses arrows only, freeing A/S/X for unit commands. Smooth acceleration is applied per frame.",
        wasdBinding: "`W` `A` `S` `D` or `←` `↑` `↓` `→`",
        classicBinding: "`←` `↑` `↓` `→`",
        source: "input.ts:1291-1297",
        kind: "mode",
      },
      // input.ts:1299-1307 — edge pan engages within 12 px while the pointer is inside the canvas.
      {
        binding: "Pointer at `screen edge`",
        action: "Edge-pan camera",
        note: "Push within 12 px of a battlefield edge. It only runs while the pointer is over the game canvas.",
        source: "input.ts:1299-1307",
        kind: "mouse",
      },
      // input.ts:655-658 and 863-869 — middle mouse starts a pan drag; movement scales with camera height.
      {
        binding: "`Middle-drag`",
        action: "Drag-pan camera",
        note: "Grab the battlefield and drag. Pan speed scales with zoom height.",
        source: "input.ts:655-658, 863-869",
        kind: "mouse",
      },
      // input.ts:92-104 — wheel and ctrl-pinches are normalized before calling zoom.
      {
        binding: "`Mouse wheel` / `trackpad pinch`",
        action: "Zoom camera",
        note: "Scroll or pinch over the battlefield. Trackpad pinch and two-finger scroll deltas are normalized.",
        source: "input.ts:92-104",
        kind: "mouse",
      },
      // input.ts:270-278 — Equal/NumpadAdd zoom in, Minus/NumpadSubtract zoom out; both repeat.
      {
        binding: "`=` or `Num +`",
        action: "Zoom in",
        note: "The physical equals key works whether or not Shift is held. Holding it repeats smoothly.",
        source: "input.ts:270-278",
      },
      {
        binding: "`-` or `Num −`",
        action: "Zoom out",
        note: "Numpad subtract is supported alongside the main keyboard minus key.",
        source: "input.ts:270-278",
      },
      // input.ts:279-292 — brackets rotate in fixed steps; backslash resets yaw.
      {
        binding: "`[` / `]`",
        action: "Rotate camera CCW / CW",
        note: "Each tap rotates by 0.18 radians; holding the key repeats.",
        source: "input.ts:279-288",
      },
      {
        binding: "`\\`",
        action: "Reset camera north-up",
        note: "Instantly clears camera yaw and flashes a north-up confirmation label.",
        source: "input.ts:289-292",
      },
      // input.ts:640-643 and 822-826 — Alt plus either left or middle button enters yaw-drag; only horizontal delta rotates.
      {
        binding: "`Alt` + `Left-drag` or `Alt` + `Middle-drag`",
        action: "Free-rotate camera",
        note: "Horizontal mouse movement rotates the camera while Alt is held.",
        source: "input.ts:650-653, 857-861",
        kind: "mouse",
      },
      // input.ts:336 and 556-567 — H/Home centers the conyard, falling back to the spawn point.
      {
        binding: "`H` or `Home`",
        action: "Jump to base",
        note: "Centers your Construction Yard; if it is gone, falls back to your original spawn.",
        source: "input.ts:336, 556-567",
      },
      // input.ts:337 and 569-575 — Space prefers the last alert/ping position and otherwise jumps home.
      {
        binding: "`Space`",
        action: "Jump to last alert",
        note: "Centers the latest attack, superweapon, capture, sabotage, or ping location; falls back to base when no alert exists.",
        source: "input.ts:337, 569-575",
      },
      // input.ts:338 and 577-590 — C centers the average position of the current selection.
      {
        binding: "`C`",
        action: "Center on selection",
        note: "Uses the average position of everything currently selected.",
        source: "input.ts:338, 577-590",
      },
      // hud.ts:948-970 — left press/drag on the minimap navigates the camera continuously.
      {
        binding: "`Left-click` / `drag` on minimap",
        action: "Move camera through minimap",
        note: "Click to jump, or hold and scrub across the map. In spectator mode this also disengages Auto-Cam.",
        source: "hud.ts:948-970; main.ts:564-572",
        kind: "mouse",
      },
    ],
  },
  {
    id: "orders",
    kicker: "02 / COMMAND AUTHORITY",
    title: "Unit Orders",
    desc: "Contextual right-click orders cover most RTS play. Attack-Move, Stop, and Scatter are the bindings that change when you toggle input modes.",
    rows: [
      // input.ts:703 and 1018-1103 — plain right-click issues a contextual order through issueOrder.
      {
        binding: "`Right-click` ground",
        action: "Move selected units",
        note: "The order marker is green for a normal move. Aircraft, ships, vehicles, and infantry path according to their own domain.",
        source: "input.ts:703, 1018-1103",
        kind: "mouse",
      },
      // input.ts:1067-1069 — enemy entities convert the same right-click into a targeted attack.
      {
        binding: "`Right-click` enemy",
        action: "Attack target",
        note: "Focuses the selected force on that enemy when it is not allied.",
        source: "input.ts:1067-1069",
        kind: "mouse",
      },
      // input.ts:1083-1096 — harvesters turn ore/refinery clicks into harvest orders; engineers can capture neutral economy structures.
      {
        binding: "`Right-click` ore or refinery",
        action: "Harvest / unload ore",
        note: "Applies when a harvester is in the selection. Right-clicking a neutral derrick or coal mine with an engineer selected sends the capture order.",
        source: "input.ts:1083-1096",
        kind: "mouse",
      },
      // input.ts:1070-1082 — right-clicking your own transport with infantry in the selection boards it.
      {
        binding: "`Right-click` own transport",
        action: "Board transport",
        note: "Infantry board the Hornet Gunship transport (4 seats). Mixed selections degrade non-infantry to a plain move, matching the server.",
        source: "input.ts:1070-1082",
        kind: "mouse",
      },
      // input.ts:703 and 1098-1101 — Shift passes queue:true and produces a queued waypoint label/marker.
      {
        binding: "`Shift` + `Right-click`",
        action: "Queue waypoint",
        note: "Works for battlefield orders and armed Attack-Move/Patrol/Unload orders. Repeat to append a route.",
        source: "input.ts:703, 1098-1101",
        kind: "mouse",
      },
      // input.ts:316-320 chooses F in WASD mode or A in classic mode; 739-756 and 1056-1058 execute it.
      {
        action: "Attack-Move",
        note: "Requires owned mobile units in the selection. Arm the mode, then left-click or right-click the destination; units fight enemies encountered en route.",
        wasdBinding: "`F`, then `Left-click` / `Right-click`",
        classicBinding: "`A`, then `Left-click` / `Right-click`",
        source: "input.ts:316-320, 739-756, 1056-1058",
        kind: "mode",
      },
      // input.ts:331 and 758-776 arm/toggle patrol; 1059-1061 converts the next order to patrol.
      {
        binding: "`P`, then `Left-click` / `Right-click`",
        action: "Patrol route",
        note: "Units march back and forth along the route. Press P again before clicking to disarm the toggle; Shift queues the patrol waypoint.",
        source: "input.ts:331, 758-776, 1059-1061",
      },
      // input.ts:332 and 778-801 arm/toggle unload for a selected transport; 1062-1066 and 1006-1009 convert battlefield/minimap clicks into unload orders.
      {
        binding: "`U`, then `Left-click` / `Right-click`",
        action: "Unload transport",
        note: "Requires a selected troop transport. Click the drop zone — passengers disembark onto the nearest passable tile once the transport arrives. Press U again to disarm; Shift queues the unload.",
        source: "input.ts:332, 778-801, 1062-1066",
      },
      // input.ts:333 and 1144-1154 — G toggles hold for every selected unit.
      {
        binding: "`G`",
        action: "Toggle Hold Position",
        note: "Held units fire at enemies in range without chasing. Pressing G again turns hold off when all selected units are already held.",
        source: "input.ts:333, 1144-1154",
      },
      // input.ts:316-320 chooses X in WASD mode or S in classic mode; 1156-1163 sends stop.
      {
        action: "Stop / clear waypoints",
        note: "Halts selected owned mobile units and clears their queued orders.",
        wasdBinding: "`X`",
        classicBinding: "`S`",
        source: "input.ts:316-320, 1156-1163",
        kind: "mode",
      },
      // input.ts:316-323 — classic X scatters. In WASD mode X is already Stop, so Scatter has no WASD binding.
      {
        action: "Scatter",
        note: "Explodes the formation outward by roughly 2.6 tiles per unit. There is deliberately no WASD-mode binding because X is Stop there.",
        wasdBinding: "`—`",
        classicBinding: "`X`",
        source: "input.ts:316-323, 598-629",
        kind: "mode",
      },
      // input.ts:975-1016 implements minimap orders; hud.ts:951-969 routes right clicks there first.
      {
        binding: "`Right-click` minimap",
        action: "Issue map order",
        note: "Sends selected units to the clicked map position. If Attack-Move, Patrol, or Unload is armed, that order type is used; Shift queues it.",
        source: "input.ts:975-1016; hud.ts:951-969",
        kind: "mouse",
      },
      // input.ts:346-370 and 678-703 — Escape/right-click disarm order modes before any other cancellation behavior.
      {
        binding: "`Right-click` or `Esc` while armed",
        action: "Cancel armed order mode",
        note: "Clears Attack-Move, Patrol, Unload, Sell/Repair/Bridge, placement, recon, or nuclear targeting before a normal order is issued.",
        source: "input.ts:346-370, 678-703",
      },
    ],
    note: "A left-drag longer than 6 px always becomes box-select, even while an order mode is armed; the armed mode yields instead of eating the drag (input.ts:660-675, 912-933).",
  },
  {
    id: "selection",
    kicker: "03 / FORCE CONTROL",
    title: "Control Groups & Selection",
    desc: "Selection is ownership-aware. Box selection intentionally grabs mobile units only; individual clicks can still select production buildings for rally points and upgrades.",
    rows: [
      // input.ts:940-971 — plain left click picks one owned entity; clicks elsewhere clear unless Shift is held.
      {
        binding: "`Left-click`",
        action: "Select one owned entity",
        note: "Works for mobile units and your buildings. Clicking empty ground or a non-owned entity clears the selection unless Shift is held.",
        source: "input.ts:940-971",
        kind: "mouse",
      },
      // input.ts:912-933 box-selects ids from renderer.mySelectableIds; render.ts:1576-1580 excludes buildings.
      {
        binding: "`Left-drag`",
        action: "Box-select mobile units",
        note: "The cyan box selects owned mobile units whose screen positions fall inside it. Buildings are deliberately not box-selected.",
        source: "input.ts:912-933; render.ts:1576-1580",
        kind: "mouse",
      },
      // input.ts:919 and 956-960 — Shift starts from the old selection and toggles clicked entities.
      {
        binding: "`Shift` + `Left-click` / `Left-drag`",
        action: "Add or toggle selection",
        note: "Shift-click toggles an owned entity in/out; Shift-drag adds the boxed units to the existing selection.",
        source: "input.ts:919, 956-960",
        kind: "mouse",
      },
      // input.ts:944-955 — double click selects all visible same-kind owned units on screen.
      {
        binding: "`Double-click` unit",
        action: "Select same type on screen",
        note: "Selects every visible owned unit of that exact kind in the viewport. Starting with Shift held adds them instead.",
        source: "input.ts:944-955",
        kind: "mouse",
      },
      // input.ts:298-313 — Alt+1..9 is the primary assign chord; Ctrl/Cmd+Shift+1..9 is also accepted because plain Ctrl+number belongs to browser tabs.
      {
        binding: "`Alt` + `1`–`9` or `Ctrl`/`Cmd` + `1`–`9`",
        action: "Assign control group",
        note: "Stores the currently selected owned entities. Ctrl/Cmd+number reaches the game in fullscreen (Keyboard Lock captures the browser's tab shortcut); in a normal window the browser still switches tabs, so prefer Alt or fullscreen.",
        source: "input.ts:298-313, 478-488; util.ts syncKeyboardLock",
      },
      // input.ts:312 and 490-508 — number recalls, Shift adds, and a fast second tap centers.
      {
        binding: "`1`–`9`",
        action: "Recall control group",
        note: "Dead or captured members are pruned. Tap the same number twice within 420 ms to recall and center the camera.",
        source: "input.ts:312, 490-508",
      },
      {
        binding: "`Shift` + `1`–`9`",
        action: "Add group to selection",
        note: "Merges the group's surviving units into the current selection instead of replacing it.",
        source: "input.ts:312, 490-508",
      },
      // main.ts:573-576 and hud.ts:3195-3204 expose the same groups in the clickable group bar.
      {
        binding: "Click / double-click `group chip`",
        action: "Recall or center from group bar",
        note: "The chips under the left support buttons mirror control groups: click selects, double-click centers.",
        source: "main.ts:573-576; hud.ts:3195-3204",
        kind: "ui",
      },
      // input.ts:339 and 510-521 — Q selects every owned non-building except harvesters.
      {
        binding: "`Q`",
        action: "Select all combat units",
        note: "Selects every owned mobile combat unit across the map, excluding harvesters and buildings.",
        source: "input.ts:339, 510-521",
      },
      // input.ts:340-343 and 523-532 — F1 cycles through harvesters, selecting and centering each one.
      {
        binding: "`F1`",
        action: "Cycle harvesters",
        note: "Selects and centers the next owned harvester, rotating through the fleet.",
        source: "input.ts:340-343, 523-532",
      },
    ],
  },
  {
    id: "production",
    kicker: "04 / INDUSTRIAL CHAIN",
    title: "Production & Buildings",
    desc: "Construction is mostly pointer-driven, with B as the critical ready-to-place hotkey. Structures and defenses run in parallel queues.",
    rows: [
      // hud.ts:857-872 creates build buttons; clickBuild at hud.ts:1798-1801 starts construction or enters placement when ready.
      {
        binding: "`Left-click` structure / defense icon",
        action: "Build or queue construction",
        note: "Adds the item to its structure or defense queue. When the icon says READY, clicking enters placement instead.",
        source: "hud.ts:857-872, 1798-1801",
        kind: "ui",
      },
      // hud.ts:868-872 cancels ready or busy construction; hud.ts:2931-2957 documents the refund behavior in item state text.
      {
        binding: "`Right-click` structure / defense icon",
        action: "Cancel and refund",
        note: "Cancels the in-progress, queued, or finished-but-unplaced item and refunds it. This is different from stowing placement on the battlefield.",
        source: "hud.ts:868-872, 2931-2957",
        kind: "ui",
      },
      // input.ts:326-329 routes B; main.ts:531-546 chooses the next awaiting structure/defense, cycles kinds, or stows a singleton.
      {
        binding: "`B`",
        action: "Place finished building / defense",
        note: "Arms placement for the next ready item. Pressing B again cycles multiple ready kinds; with only one ready kind it stows the ghost.",
        source: "input.ts:326-329; main.ts:531-546",
      },
      // input.ts:731-733 and 1265-1281 place on click; input.ts:693-697 and 1257-1262 stow without deleting the finished structure.
      {
        binding: "`Left-click` battlefield while placing",
        action: "Deploy building ghost",
        note: "Green means valid. Red shows the exact blocking reason — terrain, water, ore, units, structures, or distance from base.",
        source: "input.ts:731-733, 1265-1281",
        kind: "mouse",
      },
      {
        binding: "`Right-click` or `Esc` while placing",
        action: "Stow placement",
        note: "Returns the ghost to READY in the sidebar; it is not deleted or refunded. Use right-click on the sidebar item if you want to cancel and refund.",
        source: "input.ts:364-366, 693-697, 1257-1262",
      },
      // hud.ts:900-913 — left click trains once, Shift clicks five times, right click cancels.
      {
        binding: "`Left-click` unit icon",
        action: "Train one unit",
        note: "Adds the unit to the appropriate production queue when its building and tech prerequisites are available.",
        source: "hud.ts:900-909",
        kind: "ui",
      },
      {
        binding: "`Shift` + `Left-click` unit icon",
        action: "Train five units",
        note: "Queues five of the same unit with one click.",
        source: "hud.ts:906-909",
        kind: "ui",
      },
      {
        binding: "`Right-click` unit icon",
        action: "Cancel queued unit",
        note: "Sends a cancellation for that unit type in its production category.",
        source: "hud.ts:910-913",
        kind: "ui",
      },
      // input.ts:344 and 534-554 — Tab cycles conyards and all production buildings, selecting/centering them.
      {
        binding: "`Tab`",
        action: "Cycle production buildings",
        note: "Selects and centers the next Construction Yard, Barracks, War Factory, Air Command, or Naval Shipyard, including MkII upgrades.",
        source: "input.ts:344, 534-554",
      },
      // input.ts:1021-1047 — if only one own production building is selected and no mobile units are selected, right-click sets rally.
      {
        binding: "Select production building, then `Right-click` ground",
        action: "Set rally point",
        note: "Applies to Barracks, War Factory, Air Command, and Naval Shipyard production buildings. Newly produced units rally there.",
        source: "input.ts:1021-1047",
        kind: "mouse",
      },
      // input.ts:334-335 and 811-853 — V/R arm mutually exclusive sell/repair verbs and toggle off when repeated.
      {
        binding: "`V`, then `Left-click` your building",
        action: "Sell building",
        note: "Arms Sell mode; pressing V again, right-clicking, or Esc cancels. The in-game verb button also exposes this mode.",
        source: "input.ts:334, 811-853",
      },
      {
        binding: "`R`, then `Left-click` your building",
        action: "Repair building",
        note: "Arms Repair mode; pressing R again, right-clicking, or Esc cancels.",
        source: "input.ts:335, 811-853",
      },
      // input.ts:811-842 — bridge is a verb button, not a keyboard binding; it requires a selected engineer and water target.
      {
        binding: "Select engineer → click `BRIDGE` → `Left-click` water",
        action: "Build pontoon bridge",
        note: "There is currently no dedicated keyboard hotkey for Bridge. The verb costs $40 per water tile and is capped by the server.",
        source: "input.ts:811-842; index.html:57",
        kind: "ui",
      },
    ],
    note: "Accuracy note: the legacy in-game button label mentions “$” for Sell, but input.ts only binds V (input.ts:334). This reference follows the executable code rather than that label.",
  },
  {
    id: "support",
    kicker: "05 / THEATER SYSTEMS",
    title: "Support Powers, Chat & UI",
    desc: "Strategic powers are deliberately click-targeted rather than hotkeyed. Global UI keys are context-sensitive and never fire while you are typing.",
    rows: [
      // input.ts:243-252 — Alt+Enter is intercepted before the plain-Enter chat focus.
      {
        binding: "`Alt` + `Enter`",
        action: "Toggle fullscreen",
        note: "Also available as the ⛶ button in the top bar. Esc exits fullscreen at the browser level.",
        source: "input.ts:243-252; util.ts toggleFullscreen; hud.ts fs-btn",
        kind: "ui",
      },
      // input.ts:410-466 arms support modes; input.ts:709-729 fires on the battlefield, and 975-990 handles minimap targets.
      {
        binding: "Click `RECON` pill, then `Left-click` battlefield or `Right-click` minimap",
        action: "Target recon scan",
        note: "Requires a ready, powered recon scan. Right-click or Esc cancels before firing.",
        source: "input.ts:410-466, 709-729, 975-990; main.ts:556-561",
        kind: "ui",
      },
      {
        binding: "Click `NUKE` pill, then `Left-click` battlefield or `Right-click` minimap",
        action: "Target nuclear strike",
        note: "Requires a ready, powered Nuclear Silo. Right-click or Esc cancels before launch.",
        source: "input.ts:410-466, 709-729, 975-990; main.ts:556-561",
        kind: "ui",
      },
      // hud.ts:956-963 — Alt prevents minimap-order handling, so the click always becomes a ping.
      {
        binding: "`Alt` + `Right-click` minimap",
        action: "Ping map for teammates",
        note: "If no order is possible, a minimap right-click also falls back to ping. Pings update the Space-key alert location.",
        source: "hud.ts:956-963; main.ts:562, 999-1002",
        kind: "mouse",
      },
      // input.ts:243-248 focuses chat; hud.ts:843-853 sends on Enter or blurs on Escape.
      {
        binding: "`Enter`",
        action: "Open chat / send message",
        note: "Enter focuses the chat box. Inside chat, Enter sends and blurs; Esc closes the input without sending.",
        source: "input.ts:243-248; hud.ts:843-853",
      },
      // input.ts:346-370 implements in-match cancellation; hud.ts:733-759 closes MCP/watch/graphics modals.
      {
        binding: "`Esc`",
        action: "Cancel, close, or deselect",
        note: "Priority order: close Help, disarm nuke/recon, clear armed orders/verbs, stow placement, then clear selection. It also closes Watch, MCP, and Graphics panels.",
        source: "input.ts:346-370; hud.ts:733-759",
      },
      // input.ts:190-194 persists the mode; hud.ts:1768-1781 changes the button and verb labels.
      {
        binding: "Click `KEYS: WASD` / `KEYS: RTS`",
        action: "Toggle input mode",
        note: "Stored in localStorage. WASD is the default camera-pan mode; RTS is the classic A/S/X hotkey mode.",
        source: "input.ts:19, 190-194; hud.ts:1766-1781",
        kind: "ui",
      },
      // hud.ts:642-643 and main.ts:578 — pause is a button only and is shown for solo-vs-bot matches.
      {
        binding: "Click `⏸ PAUSE`",
        action: "Pause solo match",
        note: "Button-only; no keyboard shortcut is registered. It appears only in solo games against bots.",
        source: "hud.ts:642-643; main.ts:578, 691",
        kind: "ui",
      },
      // input.ts:210-221 and 234-241 — modals and typing targets suppress gameplay hotkeys.
      {
        binding: "Typing in `input`, `textarea`, or `select`",
        action: "Gameplay hotkeys suspended",
        note: "The Input handler ignores keystrokes aimed at form fields; Esc blurs the field. Open modal panels also block game hotkeys except Esc.",
        source: "input.ts:210-221, 234-241",
        kind: "access",
      },
    ],
  },
  {
    id: "fpv",
    kicker: "06 / DIRECT CONTROL",
    title: "First-Person (FPV) Mode",
    desc: "Press E on exactly one owned mobile unit and the RTS camera becomes a first-person controller. These inputs are captured by FPV regardless of the RTS hotkey mode.",
    rows: [
      // input.ts:250-261 enters only for one owned non-building; fpv.ts:2802-2807 exits on E.
      {
        binding: "`E`",
        action: "Enter / exit first-person",
        note: "Enter requires exactly one owned mobile unit selected — infantry, vehicle, aircraft, or ship. Press E again to step out.",
        source: "input.ts:250-261; fpv.ts:2802-2807",
      },
      // fpv.ts:2851-2871 and 2885-2916 — first unlocked click locks/drag-looks; mouse movement then aims.
      {
        binding: "`Left-click` canvas, move `mouse`",
        action: "Lock pointer / aim",
        note: "The first click acquires pointer lock without firing. If lock is unavailable, hold left or right mouse and drag to look.",
        source: "fpv.ts:2851-2871, 2885-2916",
        kind: "mouse",
      },
      // fpv.ts:2295-2300 — W/S and vertical arrows produce forward/reverse input.
      {
        binding: "`W` / `S` or `↑` / `↓`",
        action: "Accelerate / reverse",
        note: "Drives forward and backward for infantry, vehicles, ships, and aircraft. Client prediction uses the same drive input sent to the server.",
        source: "fpv.ts:2295-2300",
      },
      // fpv.ts:2299-2320 — A/D strafe in infantry mode, otherwise steer with light lateral drift; horizontal arrows always turn.
      {
        binding: "`A` / `D` and `←` / `→`",
        action: "Strafe or steer / turn",
        note: "Infantry strafe with A/D. Vehicles, ships, and aircraft steer with A/D plus slight lateral drift; arrow left/right always turn the view.",
        source: "fpv.ts:2299-2320",
      },
      // fpv.ts:2413-2435 — air-domain units convert sustained render pitch into climb/dive commands.
      {
        binding: "Pitch `mouse` up / down",
        action: "Control aircraft altitude",
        note: "In aircraft, camera pitch becomes a climb or dive command after a small center deadzone.",
        source: "fpv.ts:2413-2435",
        kind: "mouse",
      },
      // fpv.ts:2302-2305 — either shift key sets the sprint flag; server applies the same x1.4 multiplier.
      {
        binding: "`Shift`",
        action: "Sprint / boost",
        note: "Hold either Shift key for the shared ×1.4 movement boost.",
        source: "fpv.ts:2302-2305, 541",
      },
      // fpv.ts:2408-2410 and 2859-2866 — mouse or space sets the fire bit when the unit has a weapon.
      {
        binding: "`Left-click` or `Space`",
        action: "Fire weapon",
        note: "After pointer lock, hold left mouse or Space. Unarmed utility units do not fire.",
        source: "fpv.ts:2408-2410, 2859-2866",
        kind: "mouse",
      },
      // fpv.ts:2307-2310 and 2867-2871 — RMB ADS applies only to infantry kinds while pointer locked.
      {
        binding: "Hold `Right-click`",
        action: "Aim down sights (infantry)",
        note: "Applies to infantry, rocket troops, and engineers while pointer-locked. When not locked, right mouse is a drag-look fallback instead.",
        source: "fpv.ts:2307-2310, 2867-2871",
        kind: "mouse",
      },
      // fpv.ts:2829-2831 and 2321-2324 — C toggles crouch for infantry kinds, halving movement and bracing recoil.
      {
        binding: "`C`",
        action: "Toggle crouch (infantry)",
        note: "Infantry, rocket troops, and engineers move slower, sit lower, and gain steadier recoil while crouched.",
        source: "fpv.ts:2321-2324, 2829-2831",
      },
      // fpv.ts:577-579 and 2832-2839 — only multi-weapon names currently exist for the AC-130.
      {
        binding: "`1` / `2` / `3`",
        action: "Select weapon on multi-gun platforms",
        note: "Currently meaningful on the AC-130: 105 mm howitzer, 40 mm Bofors, and 25 mm Gatling.",
        source: "fpv.ts:577-579, 2832-2839",
      },
      // fpv.ts:2494-2534 and 564-576 — holding the reticle on enemies acquires guided lock for listed platforms.
      {
        binding: "Hold `reticle` on enemy",
        action: "Acquire guided lock-on",
        note: "Guided platforms include rocket troops, interceptors, UAVs, gunboats, destroyers, HIMARS, stealth bombers, Shaheds, hypersonics, submarines, and dreadnoughts.",
        source: "fpv.ts:564-576, 2494-2534",
        kind: "mouse",
      },
      // fpv.ts:2809-2822 — Escape exits pointer lock first; without lock it exits FPV.
      {
        binding: "`Esc`",
        action: "Release mouse / exit FPV",
        note: "When pointer-locked, Esc releases the mouse. When not pointer-locked, Esc exits first-person mode; E always exits directly.",
        source: "fpv.ts:2809-2822",
      },
    ],
    note: "FPV captures R and F in its key set, but the current handler gives them no gameplay effect; they are reserved rather than functional bindings (fpv.ts:544-562, 2824-2840).",
  },
  {
    id: "spectator",
    kicker: "07 / LIVE OBSERVER",
    title: "Spectator & Watch Mode",
    desc: "Spectators keep the camera and minimap controls but cannot issue real unit orders because they own no forces. Auto-Cam and commander focus are button-driven.",
    rows: [
      // main.ts:36-43 parses spectate/watch; main.ts:649 opens the dashboard; main.ts:1015-1020 joins with spectator identity.
      {
        binding: "`?watch=1` URL",
        action: "Open live spectator dashboard",
        note: "Lists online matches and can launch the instant three-way AI battle. The dashboard refreshes every five seconds.",
        source: "main.ts:36-43, 649",
        kind: "access",
      },
      {
        binding: "`?spectate=1` room URL",
        action: "Join as spectator",
        note: "Uses an ephemeral join token so spectating never steals or replaces a player slot.",
        source: "main.ts:36-43, 50-51, 1015-1020",
        kind: "access",
      },
      // Spectator camera path is the same Input implementation as the player camera.
      {
        binding: "`WASD` / `arrows`, `wheel`, `middle-drag`, `[` / `]`",
        action: "Observe with normal camera controls",
        note: "WASD follows the current KEYS mode, arrows always pan, wheel zooms, middle-drag pans, and bracket/Alt-drag rotation still work.",
        source: "input.ts:92-104, 655-658, 1286-1326",
        kind: "mouse",
      },
      // hud.ts:689 toggles; main.ts:1061-1067 disables it on manual movement.
      {
        binding: "Click `AUTO-CAM`",
        action: "Toggle battle-following camera",
        note: "Auto-Cam scores recent combat clusters and multi-faction unit clashes. Manual panning or minimap navigation turns it off.",
        source: "main.ts:111-119, 1061-1083; hud.ts:689",
        kind: "ui",
      },
      // main.ts:121-164 computes focus; commander buttons are generated in hud.ts:1537-1544.
      {
        binding: "Click `commander chip`",
        action: "Focus a commander",
        note: "Centers the camera on that player's mobile force when possible, otherwise their Construction Yard, base mass, or spawn.",
        source: "main.ts:121-164; hud.ts:1537-1544",
        kind: "ui",
      },
      // hud.ts:948-970 navigates; because spectators have no owned units, right click falls through to ping.
      {
        binding: "`Left-click` / `Right-click` minimap",
        action: "Navigate / ping",
        note: "Left click or drag navigates the spectator camera. Right click broadcasts a ping because there are no owned units to order.",
        source: "hud.ts:948-970; main.ts:562-572",
        kind: "mouse",
      },
      // input.ts:468-474 makes myUnits empty for slot -1, so order/group hotkeys cannot send commands as a spectator.
      {
        binding: "`Q`, `1`–`9`, order hotkeys",
        action: "No command effect in spectator mode",
        note: "These keys may still be pressed, but ownership filtering leaves no selectable or orderable units for slot −1. Use them only after joining as a player.",
        source: "input.ts:468-474, 510-554",
        kind: "access",
      },
      // hud.ts:733-759 — Escape closes modal dashboards.
      {
        binding: "`Esc`",
        action: "Close Watch / Graphics / MCP panels",
        note: "The modal Escape handler runs before gameplay input.",
        source: "hud.ts:733-759",
      },
    ],
  },
  {
    id: "lobby",
    kicker: "08 / PRE-BATTLE COMMAND",
    title: "Lobby & Room Controls",
    desc: "The lobby is intentionally form-and-button driven. There are no hidden global lobby hotkeys; keyboard behavior is the browser's native input/select behavior plus two callsign shortcuts.",
    rows: [
      // hud.ts:790-817 — Enter commits callsign and blurs; Escape restores the last submitted value.
      {
        binding: "`Enter` in callsign field",
        action: "Commit callsign",
        note: "Trims to 20 characters, saves it locally, sends setName, and leaves the field.",
        source: "hud.ts:790-817",
      },
      {
        binding: "`Esc` in callsign field",
        action: "Revert callsign edit",
        note: "Restores the last submitted callsign and blurs the field.",
        source: "hud.ts:806-816",
      },
      // input.ts:237-241 — form fields are excluded from game hotkey processing.
      {
        binding: "`Tab` / `arrow keys` / `Space` / `Enter` in controls",
        action: "Native form navigation",
        note: "Map, rules, bot difficulty, spawn slot, and team controls use normal browser keyboard behavior while focused. Game hotkeys do not fire from inputs or selects.",
        source: "input.ts:237-241; hud.ts:1815-2068",
        kind: "access",
      },
      // hud.ts:586-599 wires the concrete lobby buttons.
      {
        binding: "Click `READY` / `START GAME` / `+ BOT`",
        action: "Room flow",
        note: "These are click-only buttons. READY toggles your state; START and bot controls are host-only.",
        source: "hud.ts:586-599, 2062-2068",
        kind: "ui",
      },
      // hud.ts:1877-1994 builds spawn and team controls.
      {
        binding: "Click `S#` picker / `FFA/T1–T4` badge",
        action: "Choose spawn slot / cycle team",
        note: "Spawn pickers move to empty slots or perform allowed swaps. Your team badge cycles FFA, Team 1, Team 2, Team 3, and Team 4.",
        source: "hud.ts:1877-1994",
        kind: "ui",
      },
      // No lobby branch exists in input.ts:234-371. B is a match-time placement hotkey through main.ts:531-546.
      {
        binding: "`B` in lobby",
        action: "No lobby effect",
        note: "B is not a lobby shortcut. It only becomes meaningful after the match starts and a structure or defense is READY to place.",
        source: "input.ts:326-329; main.ts:531-546",
        kind: "access",
      },
    ],
    note: "Host-only lobby controls — map, starting credits, speed, superweapons, crates, derricks, fog, logistics, bot configuration, host transfer, and start — are all explicit UI controls, not keyboard chords (hud.ts:1815-2068).",
  },
];

function kindLabel(kind: RowKind | undefined): string {
  switch (kind) {
    case "mouse":
      return "mouse";
    case "ui":
      return "ui";
    case "mode":
      return "mode split";
    case "access":
      return "context";
    default:
      return "hotkey";
  }
}

function appendModeBinding(cell: HTMLElement, label: string, binding: string): void {
  const item = el("div", "mode-bind");
  item.append(el("span", "mode-name", label));
  const keys = el("div", "mode-keys");
  appendBinding(keys, binding);
  item.append(keys);
  cell.append(item);
}

function buildRow(row: BindingRow): HTMLElement {
  const tr = el("article", `binding-row kind-${row.kind ?? "key"}`);
  const binding = el("div", "binding-cell");
  if (row.wasdBinding || row.classicBinding) {
    const matrix = el("div", "mode-matrix");
    binding.append(matrix);
    appendModeBinding(matrix, "WASD", row.wasdBinding ?? "`—`");
    appendModeBinding(matrix, "CLASSIC", row.classicBinding ?? "`—`");
  } else {
    appendBinding(binding, row.binding ?? "");
  }
  const action = el("div", "action-cell");
  action.append(el("b", "", row.action), el("span", "row-kind", kindLabel(row.kind)));
  const note = el("div", "note-cell");
  if (row.note) note.append(el("p", "", row.note));
  note.append(el("code", "source-ref", row.source));
  tr.append(binding, action, note);
  return tr;
}

function render(): void {
  const root = document.getElementById("shortcuts-app");
  if (!root) throw new Error("missing #shortcuts-app");
  root.textContent = "";

  const topbar = el("header", "topbar");
  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = "/";
  const emblem = document.createElement("img");
  emblem.src = "/favicon.svg";
  emblem.alt = "";
  const brandText = el("div");
  brandText.append(el("strong", "", "OPEN ALERT"), el("span", "", "INPUT CONTROL MANUAL"));
  brand.append(emblem, brandText);
  const actions = el("nav", "top-actions");
  const units = document.createElement("a");
  units.className = "ghost-link";
  units.href = "/units.html";
  units.textContent = "UNITS DATABASE";
  const guide = document.createElement("a");
  guide.className = "ghost-link";
  guide.href = "/guide.html";
  guide.textContent = "FIELD MANUAL";
  const back = document.createElement("a");
  back.className = "back-link";
  back.href = "/";
  back.textContent = "◄ BACK TO BASE";
  actions.append(units, guide, back);
  topbar.append(brand, actions);
  root.append(topbar);

  const rowCount = SECTIONS.reduce((n, section) => n + section.rows.length, 0);
  const hero = el("section", "hero");
  hero.append(el("div", "eyebrow", "SOURCE-VERIFIED INPUT INTELLIGENCE"));
  const h1 = el("h1");
  h1.append(document.createTextNode("KEYBOARD "), el("span", "", "SHORTCUTS"));
  hero.append(h1);
  hero.append(
    el(
      "p",
      "hero-copy",
      "A complete command reference for Open Alert's two input personalities: the default WASD camera mode and the optional Classic RTS hotkey mode. Every row below was checked against the live client input handlers — including the places where mouse gestures, minimap clicks, production buttons, spectator controls, and first-person driving differ.",
    ),
  );
  const heroStats = el("div", "hero-stats");
  const heroData: [string, string][] = [
    [String(SECTIONS.length), "control sections"],
    [String(rowCount), "verified inputs"],
    ["2", "hotkey modes"],
    ["100%", "code checked"],
  ];
  for (const [num, lab] of heroData) {
    const box = el("div", "hero-stat");
    box.append(el("b", "", num), el("span", "", lab));
    heroStats.append(box);
  }
  hero.append(heroStats);
  const note = el("div", "guide-note");
  note.append(document.createTextNode("Learning the arsenal too? Open the "));
  const unitsLink = document.createElement("a");
  unitsLink.href = "/units.html";
  unitsLink.textContent = "Units Encyclopedia";
  note.append(unitsLink, document.createTextNode(" for stats, counters, and live combat footage."));
  hero.append(note);
  root.append(hero);

  const strip = el("section", "commander-strip");
  const strips: [string, string, string][] = [
    ["", "WASD MODE IS THE DEFAULT", "W/A/S/D pan the camera. Because those keys are occupied, Attack-Move is F and Stop is X. Scatter has no binding in this mode."],
    ["amber", "CLASSIC MODE FREES A/S/X", "Toggle KEYS: WASD to KEYS: RTS in the top bar. Arrows still pan; A becomes Attack-Move, S becomes Stop, and X becomes Scatter."],
    ["red", "CONTEXT BEATS KEYMAPS", "Game hotkeys are suppressed while typing or while Watch, MCP, Graphics, or Help panels are open. Escape is the universal unwind key."],
  ];
  for (const [cls, title, text] of strips) {
    const box = el("article", `strip-card ${cls}`);
    box.append(el("b", "", title), el("p", "", text));
    strip.append(box);
  }
  root.append(strip);

  const nav = el("nav", "category-nav");
  nav.setAttribute("aria-label", "Shortcut sections");
  nav.append(el("span", "nav-label", "BROWSE"));
  for (const section of SECTIONS) {
    const link = document.createElement("a");
    link.className = "cat-link";
    link.href = `#${section.id}`;
    link.textContent = section.title.replace(/ &.*/, "");
    nav.append(link);
  }
  root.append(nav);

  for (const section of SECTIONS) {
    const sec = el("section", "category-section");
    sec.id = section.id;
    const head = el("div", "category-head");
    const titleBox = el("div");
    titleBox.append(el("div", "category-kicker", section.kicker), el("h2", "", section.title));
    head.append(titleBox, el("p", "", section.desc));
    sec.append(head);

    const table = el("div", "bindings-table");
    const labels = el("div", "binding-labels");
    labels.append(el("span", "", "INPUT"), el("span", "", "ACTION"), el("span", "", "DETAILS / SOURCE"));
    table.append(labels);
    for (const row of section.rows) table.append(buildRow(row));
    sec.append(table);
    if (section.note) {
      const caveat = el("aside", "section-note");
      caveat.append(el("b", "", "IMPLEMENTATION NOTE"), document.createTextNode(` — ${section.note}`));
      sec.append(caveat);
    }
    root.append(sec);
  }

  const footer = el("footer", "footer");
  footer.append(
    el("b", "", "DATA PROVENANCE"),
    document.createTextNode(
      " — This page is hand-authored but source-audited against src/client/input.ts, fpv.ts, hud.ts, main.ts, render.ts, and the in-game help markup. Source references are implementation line numbers at the time of writing, not stable deep links. The executable code is the authority: in particular, Sell is V (not the legacy “$” label), Scatter exists only in Classic mode, R/F are reserved no-ops inside FPV, and the lobby has no hidden global hotkeys. Return to the ",
    ),
  );
  const home = document.createElement("a");
  home.href = "/";
  home.textContent = "multiplayer lobby";
  footer.append(home, document.createTextNode(" when you are ready to command."));
  root.append(footer);
}

render();

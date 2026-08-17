// The DOM-adapter half of gestures.js, driven through a real EventTarget with
// property-assigned Events (Node has both) — pinning the behaviors the
// adversarial review flagged as riskiest untested: the mouse hover guard vs
// pointerup (the ghost-pointer bug), plain-wheel gating, ctrl-wheel phase
// synthesis, the tap tracker (incl. its pointercancel cleanup and the compat
// dblclick echo), and detach. NOTE: the dblclick-echo window is module-global
// state, so test order below is deliberate — mouse-dblclick cases run BEFORE
// any touch double-tap plants an echo timestamp.
import test from "node:test";
import assert from "node:assert/strict";

import { attachGestures } from "../../web/js/reader/gestures.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (type, props) =>
  Object.assign(new Event(type, { cancelable: true, bubbles: true }), props);
const touch = (el, type, id, x, y) =>
  el.dispatchEvent(ev(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1,
                              clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1 }));
const mouse = (el, type, x, y, buttons) =>
  el.dispatchEvent(ev(type, { pointerId: 99, pointerType: "mouse", isPrimary: true,
                              clientX: x, clientY: y, buttons }));

function harness() {
  const el = new EventTarget();
  const calls = { pinch: [], pan: [], dbl: [], wheelPan: [] };
  const detach = attachGestures(el, {
    onPinch: (g) => calls.pinch.push(g),
    onPan: (p) => calls.pan.push(p),
    onDoubleTap: (g) => calls.dbl.push(g),
  });
  return { el, calls, detach };
}

test("mouse dblclick fires onDoubleTap (no touch echo pending)", () => {
  const { el, calls, detach } = harness();
  const propagated = el.dispatchEvent(ev("dblclick", { clientX: 10, clientY: 10 }));
  assert.equal(calls.dbl.length, 1);
  assert.equal(propagated, false); // preventDefault'ed
  detach();
});

test("mouse pointerup reaches the reducer: no ghost pointer, next touch is NOT a pinch", () => {
  const { el, calls, detach } = harness();
  mouse(el, "pointerdown", 100, 100, 1);
  mouse(el, "pointerup", 100, 100, 0);   // buttons=0 by spec — must still be processed
  touch(el, "pointerdown", 1, 200, 200); // would pair with the ghost pre-fix
  touch(el, "pointermove", 1, 230, 200);
  assert.equal(calls.pinch.length, 0, "spurious pinch against a ghost mouse pointer");
  assert.ok(calls.pan.length >= 1);      // a lone live pointer pans
  touch(el, "pointerup", 1, 230, 200);
  detach();
});

test("hover moves are still skipped (buttons=0 mouse move)", () => {
  const { el, calls, detach } = harness();
  mouse(el, "pointermove", 50, 50, 0);   // hover: never tracked
  assert.equal(calls.pan.length, 0);
  detach();
});

test("plain wheel: native unless onWheelPan is provided", () => {
  const { el, calls, detach } = harness();
  const kept = el.dispatchEvent(ev("wheel", { deltaY: 30, deltaX: 0, ctrlKey: false }));
  assert.equal(kept, true, "no onWheelPan handler -> the browser keeps the event");
  detach();
  // second adapter WITH onWheelPan: consumed and converted
  const el2 = new EventTarget();
  const pans = [];
  const d2 = attachGestures(el2, { onWheelPan: (p) => pans.push(p) });
  const kept2 = el2.dispatchEvent(ev("wheel", { deltaY: 30, deltaX: -6, ctrlKey: false }));
  assert.equal(kept2, false);
  assert.deepEqual(pans, [{ dx: 6, dy: -30 }]);
  d2();
});

test("ctrl-wheel synthesizes pinch phases with an idle end", async () => {
  const { el, calls, detach } = harness();
  el.dispatchEvent(ev("wheel", { deltaY: -40, ctrlKey: true, clientX: 5, clientY: 6 }));
  el.dispatchEvent(ev("wheel", { deltaY: -40, ctrlKey: true, clientX: 5, clientY: 6 }));
  assert.deepEqual(calls.pinch.map((g) => g.phase), ["start", "change", "change"]);
  assert.ok(calls.pinch[1].factor > 1); // zoom in
  await sleep(260); // WHEEL_END_MS idle
  assert.equal(calls.pinch.at(-1).phase, "end");
  detach();
});

test("touch double-tap fires; its compat dblclick echo is suppressed cross-adapter", async () => {
  const { el, calls, detach } = harness();
  touch(el, "pointerdown", 1, 40, 40);
  touch(el, "pointerup", 1, 41, 40);
  await sleep(40);
  touch(el, "pointerdown", 2, 42, 41);
  touch(el, "pointerup", 2, 42, 41);
  assert.equal(calls.dbl.length, 1, "double-tap recognized");
  // the browser's synthesized dblclick lands on a DIFFERENT element (the fresh
  // overlay) with its own adapter — must be treated as an echo, not a toggle
  const overlay = new EventTarget();
  const dbl2 = [];
  const d2 = attachGestures(overlay, { onDoubleTap: (g) => dbl2.push(g) });
  overlay.dispatchEvent(ev("dblclick", { clientX: 42, clientY: 41 }));
  assert.equal(dbl2.length, 0, "compat dblclick echo must not fire onDoubleTap");
  d2();
  detach();
});

test("pointercancel cleans the tap tracker; taps after a flick still double-tap", async () => {
  const { el, calls, detach } = harness();
  touch(el, "pointerdown", 5, 10, 10);      // a scroll flick:
  el.dispatchEvent(ev("pointercancel", { pointerId: 5, pointerType: "touch",
                                         clientX: 10, clientY: 10, buttons: 0 }));
  await sleep(400); // outside the double-tap window of anything above
  touch(el, "pointerdown", 6, 80, 80);
  touch(el, "pointerup", 6, 80, 80);
  await sleep(40);
  touch(el, "pointerdown", 7, 81, 80);
  touch(el, "pointerup", 7, 81, 80);
  assert.equal(calls.dbl.length, 1);
  detach();
});

test("detach removes everything", () => {
  const { el, calls, detach } = harness();
  detach();
  touch(el, "pointerdown", 1, 0, 0);
  touch(el, "pointermove", 1, 50, 50);
  el.dispatchEvent(ev("wheel", { deltaY: -40, ctrlKey: true }));
  el.dispatchEvent(ev("dblclick", { clientX: 1, clientY: 1 }));
  assert.deepEqual([calls.pinch.length, calls.pan.length, calls.dbl.length], [0, 0, 0]);
});

"use strict";

// These blocks are emitted by Codex for control data, not conversation text.
// Keep this list explicit: arbitrary XML-like text in a user's prompt or an
// assistant's answer must remain visible.
const HIDDEN_CONTROL_MARKERS = Object.freeze([
  Object.freeze({ open: "<oai-mem-citation>", close: "</oai-mem-citation>" }),
  Object.freeze({ open: "<turn_aborted>", close: "</turn_aborted>" }),
]);

function longestSuffixPrefix(text, candidates) {
  let longest = 0;
  for (const candidate of candidates) {
    const limit = Math.min(text.length, candidate.length - 1);
    for (let length = limit; length > longest; length--) {
      if (text.endsWith(candidate.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function nextOpening(text, markers) {
  let match = null;
  for (const marker of markers) {
    const index = text.indexOf(marker.open);
    if (index === -1) continue;
    if (!match || index < match.index || index === match.index && marker.open.length > match.marker.open.length) {
      match = { index, marker };
    }
  }
  return match;
}

class HiddenControlMarkupParser {
  #pending = "";
  #active = null;

  push(chunk) {
    this.#pending += String(chunk || "");
    let visible = "";
    while (this.#pending) {
      if (this.#active) {
        const closeIndex = this.#pending.indexOf(this.#active.close);
        if (closeIndex !== -1) {
          this.#pending = this.#pending.slice(closeIndex + this.#active.close.length);
          this.#active = null;
          continue;
        }
        const keep = longestSuffixPrefix(this.#pending, [this.#active.close]);
        this.#pending = this.#pending.slice(this.#pending.length - keep);
        break;
      }

      const opening = nextOpening(this.#pending, HIDDEN_CONTROL_MARKERS);
      if (opening) {
        visible += this.#pending.slice(0, opening.index);
        this.#pending = this.#pending.slice(opening.index + opening.marker.open.length);
        this.#active = opening.marker;
        continue;
      }

      const keep = longestSuffixPrefix(this.#pending, HIDDEN_CONTROL_MARKERS.map((marker) => marker.open));
      visible += this.#pending.slice(0, this.#pending.length - keep);
      this.#pending = this.#pending.slice(this.#pending.length - keep);
      break;
    }
    return visible;
  }

  finish() {
    if (this.#active) {
      this.#pending = "";
      this.#active = null;
      return "";
    }
    const visible = this.#pending;
    this.#pending = "";
    return visible;
  }
}

function stripHiddenControlMarkup(text) {
  const parser = new HiddenControlMarkupParser();
  return parser.push(text) + parser.finish();
}

window.uitHiddenMarkup = Object.freeze({
  createParser: () => new HiddenControlMarkupParser(),
  strip: stripHiddenControlMarkup,
});

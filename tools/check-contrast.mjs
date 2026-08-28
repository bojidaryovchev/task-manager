/**
 * Contrast audit for the UI palette.
 *
 * Reads the design tokens straight out of `styles.css` and checks every
 * foreground/background pair the interface actually uses against WCAG 2.1
 * contrast minimums, so a palette change cannot quietly make a label
 * unreadable.
 *
 * Thresholds: 4.5:1 for normal text, 3:1 for large text (>=18.66px bold or
 * >=24px) and for non-text elements that carry meaning, such as chart strokes
 * and bar fills.
 *
 * Usage: node tools/check-contrast.mjs
 * Exits non-zero if any required pair fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css');

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

function parseTokens(css) {
  const tokens = new Map();
  const themeBlock = css.slice(css.indexOf('@theme'), css.indexOf('}', css.indexOf('@theme')));
  for (const match of themeBlock.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens.set(`--${match[1]}`, match[2]);
  }
  return tokens;
}

function toRgb(hex) {
  let value = hex.replace('#', '');
  if (value.length === 3) value = [...value].map((c) => c + c).join('');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

/** Blend a translucent colour over an opaque one. */
function over(rgb, alpha, backdrop) {
  return rgb.map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha));
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

const tokens = parseTokens(readFileSync(CSS_PATH, 'utf8'));
const color = (name) => {
  const value = tokens.get(name);
  if (!value) throw new Error(`Token ${name} not found in styles.css`);
  return toRgb(value);
};

const surface0 = color('--color-surface-0');
const surface1 = color('--color-surface-1');
const surface2 = color('--color-surface-2');
const surface3 = color('--color-surface-3');
// The widget paints rgba(11,13,16,0.92) over whatever is behind it. The worst
// case for contrast is a white desktop showing through.
const widgetOverWhite = over(toRgb('#0b0d10'), 0.92, [255, 255, 255]);

/** [description, foreground token, background, threshold] */
const CHECKS = [
  ['Primary text on page background', '--color-text-primary', surface0, AA_NORMAL],
  ['Primary text on panel', '--color-text-primary', surface1, AA_NORMAL],
  ['Primary text on table header', '--color-text-primary', surface2, AA_NORMAL],
  ['Primary text on hover row', '--color-text-primary', surface3, AA_NORMAL],
  ['Secondary text on panel', '--color-text-secondary', surface1, AA_NORMAL],
  ['Secondary text on table header', '--color-text-secondary', surface2, AA_NORMAL],
  ['Secondary text on hover row', '--color-text-secondary', surface3, AA_NORMAL],
  ['Muted text on page background', '--color-text-muted', surface0, AA_NORMAL],
  ['Muted text on panel', '--color-text-muted', surface1, AA_NORMAL],
  ['Muted text on table header', '--color-text-muted', surface2, AA_NORMAL],
  ['Muted text on hover row', '--color-text-muted', surface3, AA_NORMAL],
  ['CPU value on panel', '--color-cpu', surface1, AA_NORMAL],
  ['Memory value on panel', '--color-memory', surface1, AA_NORMAL],
  ['Warn value on panel', '--color-warn', surface1, AA_NORMAL],
  ['Danger text on panel', '--color-danger', surface1, AA_NORMAL],
  ['Accent on panel', '--color-accent', surface1, AA_NORMAL],
  ['Disk accent on panel', '--color-disk', surface1, AA_NORMAL],
  ['Network accent on panel', '--color-network', surface1, AA_NORMAL],
  ['GPU accent on panel', '--color-gpu', surface1, AA_NORMAL],
  ['Strong border on panel', '--color-border-strong', surface1, AA_LARGE],
  // Widget, worst case: composited over a white desktop.
  ['Widget primary text', '--color-text-primary', widgetOverWhite, AA_NORMAL],
  ['Widget muted label', '--color-text-muted', widgetOverWhite, AA_NORMAL],
  ['Widget secondary text', '--color-text-secondary', widgetOverWhite, AA_NORMAL],
  ['Widget CPU value', '--color-cpu', widgetOverWhite, AA_NORMAL],
  ['Widget memory value', '--color-memory', widgetOverWhite, AA_NORMAL],
  ['Widget warn value', '--color-warn', widgetOverWhite, AA_NORMAL],
];

let failures = 0;
console.log('WCAG contrast audit\n');
for (const [description, tokenName, background, threshold] of CHECKS) {
  const ratio = contrast(color(tokenName), background);
  const pass = ratio >= threshold;
  if (!pass) failures += 1;
  const status = pass ? 'pass' : 'FAIL';
  console.log(
    `${status}  ${ratio.toFixed(2).padStart(5)}:1  (min ${threshold})  ${description}`,
  );
}

console.log(
  failures === 0
    ? '\nAll pairs meet their threshold.'
    : `\n${failures} pair(s) below threshold.`,
);
process.exit(failures === 0 ? 0 : 1);

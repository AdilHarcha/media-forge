import { steps } from './steps/index.js';

/*
 * Définition de workflow, deux formes :
 *  - v1 (liste)   : [{type, params}, ...]  → exécutée telle quelle
 *  - v2 (règles)  : { rules: [ { match, resize?, convert?, compress? }, ... ] }
 *
 * match    : { formats?: ["png","jpeg"], kind?: "image"|"video" }  (absent = règle par défaut)
 * resize   : { width?, height?, maxHeight? }
 * convert  : { format: "webp" | "avif" | "jpeg" | "png" | "mp4"... }   (image) / { codec: "h264"|"av1"|"vp9" } (vidéo)
 * compress : { quality, minQuality, maxBytes }                        (image)
 *            { crf, maxBytes, preset }                                (vidéo)
 *            { svgo: true }                                           (svg → svg)
 *
 * Le moteur exécute convert+compress en UN SEUL encodage (deux passes lossy dégraderaient deux fois le fichier).
 */

export function validateDefinition(def) {
  if (Array.isArray(def)) {
    if (!def.length) return 'définition vide';
    const bad = def.find((s) => !steps[s?.type]);
    return bad ? `étape inconnue: ${bad?.type}` : null;
  }
  if (!def || !Array.isArray(def.rules) || !def.rules.length) return 'v2: rules[] requis';
  for (const [i, r] of def.rules.entries()) {
    const c = r.compress ?? {};
    if (c.quality != null && (c.quality < 1 || c.quality > 100)) return `règle ${i}: quality doit être 1-100`;
    if (c.minQuality != null && c.quality != null && c.minQuality > c.quality) return `règle ${i}: minQuality > quality`;
    if (c.maxBytes != null && !(c.maxBytes > 0)) return `règle ${i}: maxBytes invalide`;
    if (r.convert?.format && !['webp', 'avif', 'jpeg', 'png'].includes(r.convert.format)) return `règle ${i}: format de sortie image inconnu`;
  }
  return null;
}

const matches = (m = {}, d) =>
  (!m.formats || m.formats.includes(d.format)) && (!m.kind || m.kind === d.kind);

export function resolvePlan(def, detected) {
  if (Array.isArray(def)) return { label: 'v1', plan: def };
  const rule = def.rules.find((r) => matches(r.match, detected));
  if (!rule) throw new Error(`aucune règle pour le format ${detected.format}`);
  const plan = [];
  const { resize, convert, compress } = rule;

  if (detected.kind === 'video') {
    plan.push({ type: 'video.transcode', params: { codec: convert?.codec ?? 'h264', ...resize, ...compress } });
  } else if (detected.format === 'svg' && !convert) {
    plan.push({ type: 'svg.optimize', params: {} });          // svg → svg : svgo
  } else {
    // sans "convert", on garde le format d'origine : la phase compress réencode dans le même format
    const format = convert?.format ?? detected.format;
    plan.push({ type: 'image.convert', params: { ...resize, ...convert, ...compress, format } });
  }
  return { label: `règle[${detected.format}]`, plan };
}

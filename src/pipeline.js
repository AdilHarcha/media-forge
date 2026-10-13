import { steps } from './steps/index.js';

/*
 * Définition de workflow, trois formes (toutes résolues en graphe de nœuds avant exécution) :
 *
 *  v1 (liste)   : [{type, params}, ...]                       → chaîne ; sortie = dernière étape
 *  v2 (règles)  : { rules: [ { match, resize?, convert?, compress?, extras? | graph? }, ... ] }
 *  v3 (graphe)  : { graph: { nodes: [ {id, from, type, params, output?} ] } }   (s'applique à tous les formats)
 *
 * match    : { formats?: ["png","jpeg"], kind?: "image"|"video" }  (absent = règle par défaut ; première qui correspond)
 * resize   : { width?, height?, maxHeight? }
 * convert  : { format: "webp"|"avif"|"jpeg"|"png" } (image) / { codec: "h264"|"av1"|"vp9" } (vidéo)
 * compress : { quality, minQuality, minSsim, maxBytes, strict }   (image)
 *            { crf, minSsim | minVmaf, maxBytes, preset, strict } (vidéo)  ·  { svgo: true } (svg → svg)
 * extras   : sorties parallèles tirées de la source : [{ name, type, params }]  ex. vignette vidéo
 * graph    : DAG libre dans une règle : nœuds {id, from: "input"|<id>, type, params, output?: true|false}
 *            sans nœud "output", toutes les feuilles sont des sorties ; nom de sortie = id du nœud ("main" = sortie principale)
 *
 * Convert + compress s'exécutent en UN SEUL encodage (deux passes lossy dégraderaient deux fois le fichier).
 */

export function validateGraph(nodes, where = 'graph') {
  if (!Array.isArray(nodes) || !nodes.length) return `${where}: nodes[] requis`;
  const ids = new Set();
  for (const n of nodes) {
    if (!n?.id || !/^[a-z0-9_-]{1,40}$/i.test(n.id)) return `${where}: id de nœud invalide (${n?.id})`;
    if (n.id === 'input') return `${where}: "input" est réservé`;
    if (ids.has(n.id)) return `${where}: id en double (${n.id})`;
    if (!steps[n.type]) return `${where}: étape inconnue (${n.type})`;
    ids.add(n.id);
  }
  for (const n of nodes) if ((n.from ?? 'input') !== 'input' && !ids.has(n.from)) return `${where}: "${n.id}" dépend d'un nœud inconnu (${n.from})`;
  // cycles : on résout les nœuds dont la source est déjà résolue, jusqu'à épuisement
  const resolved = new Set(['input']);
  let left = nodes.slice();
  while (left.length) {
    const ready = left.filter((n) => resolved.has(n.from ?? 'input'));
    if (!ready.length) return `${where}: cycle détecté`;
    ready.forEach((n) => resolved.add(n.id));
    left = left.filter((n) => !resolved.has(n.id));
  }
  return null;
}

function validateCompress(c, i) {
  if (c.quality != null && (c.quality < 1 || c.quality > 100)) return `règle ${i}: quality doit être 1-100`;
  if (c.minQuality != null && c.quality != null && c.minQuality > c.quality) return `règle ${i}: minQuality > quality`;
  if (c.minSsim != null && !(c.minSsim > 0 && c.minSsim <= 1)) return `règle ${i}: minSsim doit être dans ]0,1]`;
  if (c.minVmaf != null && !(c.minVmaf > 0 && c.minVmaf <= 100)) return `règle ${i}: minVmaf doit être dans ]0,100]`;
  if (c.maxBytes != null && !(c.maxBytes > 0)) return `règle ${i}: maxBytes invalide`;
  return null;
}

export function validateDefinition(def) {
  if (Array.isArray(def)) {
    if (!def.length) return 'définition vide';
    const bad = def.find((s) => !steps[s?.type]);
    return bad ? `étape inconnue: ${bad?.type}` : null;
  }
  if (def?.graph) return validateGraph(def.graph.nodes);
  if (!def || !Array.isArray(def.rules) || !def.rules.length) return 'rules[] ou graph requis';
  for (const [i, r] of def.rules.entries()) {
    if (r.graph) { const e = validateGraph(r.graph.nodes, `règle ${i}`); if (e) return e; continue; }
    const e = validateCompress(r.compress ?? {}, i);
    if (e) return e;
    if (r.convert?.format && !['webp', 'avif', 'jpeg', 'png'].includes(r.convert.format)) return `règle ${i}: format de sortie image inconnu`;
    for (const x of r.extras ?? []) {
      if (!x.name || !/^[a-z0-9_-]{1,40}$/i.test(x.name) || x.name === 'main') return `règle ${i}: extra sans nom valide`;
      if (!steps[x.type]) return `règle ${i}: extra, étape inconnue (${x.type})`;
    }
  }
  return null;
}

const matches = (m = {}, d) =>
  (!m.formats || m.formats.includes(d.format)) && (!m.kind || m.kind === d.kind);

// Résout une définition + le fichier détecté en graphe : { label, nodes:[{id, from, type, params, output}] }
export function resolvePlan(def, detected) {
  if (Array.isArray(def)) {
    const nodes = def.map((s, i) => ({ id: i === def.length - 1 ? 'main' : `s${i}`, from: i ? `s${i - 1}` : 'input', type: s.type, params: s.params ?? {}, output: i === def.length - 1 }));
    return { label: 'v1', nodes };
  }
  if (def.graph) return { label: 'graphe', nodes: normalize(def.graph.nodes) };

  const rule = def.rules.find((r) => matches(r.match, detected));
  if (!rule) throw new Error(`aucune règle pour le format ${detected.format}`);
  if (rule.graph) return { label: `règle[${detected.format}] graphe`, nodes: normalize(rule.graph.nodes) };

  const { resize, convert, compress } = rule;
  let main;
  if (detected.kind === 'video') {
    main = { type: 'video.transcode', params: { codec: convert?.codec ?? 'h264', ...resize, ...compress } };
  } else if (detected.format === 'svg' && !convert) {
    main = { type: 'svg.optimize', params: {} };                  // svg → svg : svgo
  } else {
    // sans "convert", on garde le format d'origine : la phase compress réencode dans le même format
    main = { type: 'image.convert', params: { ...resize, ...convert, ...compress, format: convert?.format ?? detected.format } };
  }
  const nodes = [{ id: 'main', from: 'input', ...main, output: true },
    ...(rule.extras ?? []).map((x) => ({ id: x.name, from: 'input', type: x.type, params: x.params ?? {}, output: true }))];
  return { label: `règle[${detected.format}]`, nodes };
}

// Sans nœud marqué "output", toutes les feuilles du graphe deviennent des sorties.
function normalize(raw) {
  const nodes = raw.map((n) => ({ ...n, from: n.from ?? 'input', params: n.params ?? {} }));
  if (!nodes.some((n) => n.output)) {
    const parents = new Set(nodes.map((n) => n.from));
    nodes.forEach((n) => { n.output = !parents.has(n.id); });
  }
  return nodes;
}

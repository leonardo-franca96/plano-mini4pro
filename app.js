/* Plano de voo Mini 4 Pro: interface da página. O cálculo vem do núcleo Kotlin (mapeamento-core.js). */
(() => {
  "use strict";

  const Core = MapeamentoCore.br.leonardo.mapeamento.web.MapeamentoWeb;
  const DEFAULTS = JSON.parse(Core.defaults());
  const STORE_KEY = "plano-mini4pro:v1";
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

  // ---------- Estado ----------

  function blank() {
    return { v: 2, name: "Plano", polygon: [], takeoff: null, params: { ...DEFAULTS.params }, useTerrain: true, showPhotos: false, djiNames: {}, view: null };
  }
  let state = load() || blank();
  let undo = [];
  let snap = null;            // último resultado do cálculo
  let placingTakeoff = false;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      return s && Array.isArray(s.polygon) ? fromSaved(s) : null;
    } catch { return null; }
  }
  function fromSaved(s) {
    const params = { ...DEFAULTS.params, ...s.params };
    // Planos salvos antes da v2 vinham em "Temporizada", que não fotografa sozinha no DJI Fly.
    if (s.v !== 2) params.photoMode = DEFAULTS.params.photoMode;
    return { ...blank(), ...s, v: 2, params };
  }
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* sem armazenamento */ } }, 300);
  }
  function pushUndo() {
    undo.push(JSON.stringify({ polygon: state.polygon, takeoff: state.takeoff }));
    if (undo.length > 60) undo.shift();
  }
  function coreState() {
    return JSON.stringify({ name: state.name, polygon: state.polygon, takeoff: state.takeoff, params: state.params });
  }
  function setParam(k, v) { state.params = { ...state.params, [k]: v }; changed(); }

  // ---------- Relevo (Terrarium, AWS) ----------

  const terrain = { z: 0, tiles: new Map(), box: null, loading: false, error: "" };
  const TILE = 256;

  function lonToX(lon, z) { return (lon + 180) / 360 * TILE * 2 ** z; }
  function latToY(lat, z) {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
  }
  function tileRange(box, z) {
    const [s, w, n, e] = box;
    return { x0: Math.floor(lonToX(w, z) / TILE), x1: Math.floor(lonToX(e, z) / TILE), y0: Math.floor(latToY(n, z) / TILE), y1: Math.floor(latToY(s, z) / TILE) };
  }
  function boxContains(a, b) { return a && b && b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3]; }

  function heightAt(lat, lon) {
    const z = terrain.z;
    const px = lonToX(lon, z) - 0.5, py = latToY(lat, z) - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    const v = (x, y) => {
      const t = terrain.tiles.get(`${Math.floor(x / TILE)}/${Math.floor(y / TILE)}`);
      if (!t) return NaN;
      return t[(((y % TILE) + TILE) % TILE) * TILE + (((x % TILE) + TILE) % TILE)];
    };
    const a = v(x0, y0), b = v(x0 + 1, y0), c = v(x0, y0 + 1), d = v(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  const elevation = () => (state.useTerrain && terrain.box ? heightAt : null);

  async function fetchTile(z, x, y) {
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bmp = await createImageBitmap(await r.blob());
    const cv = new OffscreenCanvas(TILE, TILE);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, TILE, TILE).data;
    const h = new Float32Array(TILE * TILE);
    for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    return h;
  }

  let terrainSeq = 0;
  async function ensureTerrain(force = false) {
    if (!state.useTerrain) { renderTerrain(); return; }
    const box = Core.terrainBox(coreState());
    if (!box) { renderTerrain(); return; }
    if (!force && boxContains(terrain.box, box)) { renderTerrain(); return; }
    const seq = ++terrainSeq;
    // Zoom 13 (~19 m por pixel no equador); menos se a área for muito grande.
    let z = 13, r = tileRange(box, z);
    while (z > 9 && (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > 64) { z--; r = tileRange(box, z); }
    terrain.loading = true; terrain.error = ""; renderTerrain();
    try {
      const jobs = [];
      for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push([x, y]);
      const tiles = new Map();
      let done = 0;
      await Promise.all(jobs.map(async ([x, y]) => {
        tiles.set(`${x}/${y}`, await fetchTile(z, x, y));
        done++; if (seq === terrainSeq) $("terrainStatus").textContent = `baixando ${done}/${jobs.length}`;
      }));
      if (seq !== terrainSeq) return;
      terrain.z = z; terrain.tiles = tiles; terrain.box = box;
    } catch (e) {
      if (seq !== terrainSeq) return;
      terrain.error = "Não foi possível baixar o relevo. Confira a internet.";
    } finally {
      if (seq === terrainSeq) { terrain.loading = false; compute(); renderTerrain(); }
    }
  }
  function renderTerrain() {
    const el = $("terrainStatus");
    el.className = "status";
    if (!state.useTerrain) el.textContent = "desligado";
    else if (terrain.loading) el.textContent = el.textContent.startsWith("baixando") ? el.textContent : "baixando…";
    else if (terrain.error) { el.textContent = "erro"; el.classList.add("bad"); }
    else if (snap && snap.terrainUsed) { el.textContent = "em uso"; el.classList.add("ok"); }
    else el.textContent = "aguardando a área";
  }

  // ---------- Mapa ----------

  const style = {
    version: 8,
    sources: {
      sat: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Imagens © Esri, Maxar, Earthstar Geographics" },
      labels: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19 },
    },
    layers: [{ id: "sat", type: "raster", source: "sat" }, { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.85 } }],
  };
  const map = new maplibregl.Map({
    container: "map", style,
    center: state.view?.center || [-47.88, -15.79], zoom: state.view?.zoom ?? 4,
    dragRotate: false, pitchWithRotate: false, doubleClickZoom: false, attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

  const empty = { type: "FeatureCollection", features: [] };
  const pt = ([lat, lon], props = {}) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } });

  // Camadas assim que o estilo existe, sem esperar as imagens de satélite (o estilo embutido pode já estar pronto).
  function setupLayers() {
    if (map.getSource("area")) return;
    for (const id of ["area", "lines", "photos", "vertices", "takeoff", "start"]) map.addSource(id, { type: "geojson", data: empty });
    map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#ff922b", "fill-opacity": 0.16 } });
    map.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": "#ff922b", "line-width": 2.5 } });
    map.addLayer({ id: "lines", type: "line", source: "lines", paint: { "line-color": ["case", ["==", ["get", "pass"], 0], "#ffd43b", "#4dd4ff"], "line-width": 2 } });
    map.addLayer({ id: "photos", type: "circle", source: "photos", paint: { "circle-radius": 2.5, "circle-color": "#ffffff" } });
    map.addLayer({ id: "start", type: "circle", source: "start", paint: {
      "circle-radius": ["case", ["get", "chosen"], 10, 8],
      "circle-color": ["case", ["get", "chosen"], "#2fb344", "rgba(47,179,68,0.15)"],
      "circle-stroke-color": ["case", ["get", "chosen"], "#ffffff", "#2fb344"], "circle-stroke-width": 3 } });
    map.addLayer({ id: "vertices", type: "circle", source: "vertices", paint: { "circle-radius": 7, "circle-color": "#ffffff", "circle-stroke-color": "#ff922b", "circle-stroke-width": 3 } });
    map.addLayer({ id: "takeoff", type: "circle", source: "takeoff", paint: { "circle-radius": 11, "circle-color": "#e8590c", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 } });
    map.addLayer({ id: "takeoff-dot", type: "circle", source: "takeoff", paint: { "circle-radius": 3.5, "circle-color": "#ffffff" } });
    if (state.polygon.length && !state.view) fit();
    changed(false);
  }
  if (map.isStyleLoaded()) setupLayers();
  map.on("style.load", setupLayers);
  map.on("load", setupLayers);
  map.on("moveend", () => { const c = map.getCenter(); state.view = { center: [c.lng, c.lat], zoom: map.getZoom() }; persist(); });

  function fit() {
    const pts = state.polygon.concat(state.takeoff ? [state.takeoff] : []);
    if (!pts.length) return;
    if (pts.length === 1) { map.jumpTo({ center: [pts[0][1], pts[0][0]], zoom: 16 }); return; }
    const b = new maplibregl.LngLatBounds();
    pts.forEach(([la, lo]) => b.extend([lo, la]));
    map.fitBounds(b, { padding: 60, duration: 0, maxZoom: 18 });
  }

  function draw() {
    if (!map.isStyleLoaded() || !map.getSource("area")) return;
    const poly = state.polygon;
    let area = empty;
    if (poly.length >= 3) area = { type: "Feature", geometry: { type: "Polygon", coordinates: [[...poly, poly[0]].map(([a, o]) => [o, a])] } };
    else if (poly.length === 2) area = { type: "Feature", geometry: { type: "LineString", coordinates: poly.map(([a, o]) => [o, a]) } };
    map.getSource("area").setData(area);
    map.getSource("vertices").setData({ type: "FeatureCollection", features: poly.map((p, i) => pt(p, { i })) });
    map.getSource("takeoff").setData({ type: "FeatureCollection", features: state.takeoff ? [pt(state.takeoff)] : [] });
    const s = snap && snap.valid ? snap : null;
    map.getSource("lines").setData({ type: "FeatureCollection", features: (s?.lines || []).map((l) => ({
      type: "Feature", properties: { pass: l.pass }, geometry: { type: "LineString", coordinates: [[l.a[1], l.a[0]], [l.b[1], l.b[0]]] } })) });
    map.getSource("photos").setData({ type: "FeatureCollection", features: (s?.photos || []).map((p) => pt(p)) });
    map.getSource("start").setData({ type: "FeatureCollection", features: (s?.startMarkers || []).map((p, i) => pt(p, { i, chosen: i === s.startIndex })) });
  }

  // Toques: o que está sob o ponteiro (vértice, decolagem ou opção de início), até 14 px.
  function hit(point) {
    let best = null;
    const test = (kind, i, ll) => {
      const q = map.project([ll[1], ll[0]]);
      const d = Math.hypot(q.x - point.x, q.y - point.y);
      if (d < 14 && (!best || d < best.d)) best = { kind, i, d };
    };
    state.polygon.forEach((p, i) => test("vertex", i, p));
    if (state.takeoff) test("takeoff", -1, state.takeoff);
    (snap?.valid ? snap.startMarkers : []).forEach((p, i) => test("start", i, p));
    return best;
  }

  let drag = null;
  let suppressClick = false;
  function startDrag(e) {
    const h = hit(e.point);
    if (!h || h.kind === "start") return;
    e.preventDefault();
    pushUndo();
    drag = h; suppressClick = true;
    map.getCanvas().style.cursor = "grabbing";
  }
  function moveDrag(e) {
    if (!drag) {
      const h = hit(e.point);
      map.getCanvas().style.cursor = h ? (h.kind === "start" ? "pointer" : "grab") : (placingTakeoff ? "crosshair" : "");
      return;
    }
    const ll = [e.lngLat.lat, e.lngLat.lng];
    if (drag.kind === "vertex") state.polygon = state.polygon.map((p, i) => (i === drag.i ? ll : p));
    else state.takeoff = ll;
    changed(false, true);
  }
  function endDrag() {
    if (!drag) return;
    drag = null; map.getCanvas().style.cursor = "";
    changed();
    setTimeout(() => { suppressClick = false; }, 0);
  }
  map.on("mousedown", startDrag);
  map.on("touchstart", (e) => { if (e.points.length === 1) startDrag(e); });
  map.on("mousemove", moveDrag);
  map.on("touchmove", (e) => { if (drag) moveDrag(e); });
  map.on("mouseup", endDrag);
  map.on("touchend", endDrag);

  map.on("click", (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const ll = [e.lngLat.lat, e.lngLat.lng];
    if (placingTakeoff) {
      pushUndo(); state.takeoff = ll; setPlacing(false); changed(); return;
    }
    const h = hit(e.point);
    if (h?.kind === "start") { setParam("startPoint", h.i); toast("Início do voo escolhido."); return; }
    if (h) return;
    pushUndo();
    state.polygon = JSON.parse(Core.insertVertex(JSON.stringify(state.polygon), ll[0], ll[1]));
    changed();
  });
  // Apagar vértice: botão direito (ou toque longo no celular).
  function removeAt(point) {
    const h = hit(point);
    if (h?.kind !== "vertex") return false;
    pushUndo();
    state.polygon = state.polygon.filter((_, i) => i !== h.i);
    changed(); toast("Vértice apagado.");
    return true;
  }
  map.on("contextmenu", (e) => { e.preventDefault(); removeAt(e.point); });
  let longTimer = 0;
  map.on("touchstart", (e) => { clearTimeout(longTimer); const p = e.point; longTimer = setTimeout(() => { if (drag && drag.kind === "vertex") { drag = null; removeAt(p); } }, 650); });
  map.on("touchmove", () => clearTimeout(longTimer));
  map.on("touchend", () => clearTimeout(longTimer));

  const touch = window.matchMedia?.("(pointer: coarse)").matches;
  const delHint = touch ? "toque longo apaga" : "botão direito apaga";

  // ---------- Cálculo e painel ----------

  let pending = 0;
  function compute() {
    snap = JSON.parse(Core.compute(coreState(), elevation(), !!state.showPhotos));
    draw(); render();
  }
  function changed(save = true, fast = false) {
    if (save) persist();
    // setTimeout (e não requestAnimationFrame): o cálculo roda mesmo com o mapa travado ou a aba em segundo plano.
    clearTimeout(pending);
    pending = setTimeout(() => { compute(); if (!fast) ensureTerrain(); }, 16);
  }

  function render() {
    const p = state.params;
    const s = snap || {};
    $("name").value !== state.name && document.activeElement !== $("name") && ($("name").value = state.name);
    // Altura e imagem
    $("gsd").value = p.gsdCm; $("gsdOut").textContent = `${fmt(p.gsdCm)} cm/px`;
    const alt = Core.altitudeForGsd(p.gsdCm);
    $("altHint").textContent = `Altura de voo: ${Math.round(alt)} m acima da decolagem${alt > 120 ? " (acima do limite de 120 m)" : ""}.`;
    if (document.activeElement !== $("alt")) $("alt").value = Math.round(alt);
    $("front").value = Math.round(p.frontOverlap * 100); $("frontOut").textContent = `${Math.round(p.frontOverlap * 100)}%`;
    $("side").value = Math.round(p.sideOverlap * 100); $("sideOut").textContent = `${Math.round(p.sideOverlap * 100)}%`;
    $("margin").value = p.marginM; $("marginOut").textContent = `${Math.round(p.marginM)} m`;
    // Caminho
    const auto = p.lineAngleDeg == null;
    $("autoAngle").checked = auto;
    const angle = auto ? (s.autoAngleDeg ?? 0) : p.lineAngleDeg;
    $("angle").value = Math.round(angle % 180); $("angle").disabled = auto;
    $("angleOut").textContent = `${Math.round(angle % 180)}°`;
    const dbl = p.type === "DOUBLE";
    $("gridSingle").classList.toggle("on", !dbl); $("gridDouble").classList.toggle("on", dbl);
    $("pitchBox").hidden = !dbl;
    $("pitch").value = p.obliquePitchDeg; $("pitchOut").textContent = `${Math.round(p.obliquePitchDeg)}°`;
    $("autoStart").checked = p.startPoint === -1;
    $("startHint").textContent = p.startPoint === -1
      ? (state.takeoff ? "O voo começa na ponta do caminho mais perto da decolagem." : "O voo começa na primeira ponta do caminho. Clique num círculo verde do mapa para escolher outra.")
      : "Clique num dos círculos verdes do mapa para mudar o início.";
    // Velocidade e fotos
    const autoSpeed = p.speedMs == null;
    $("autoSpeed").checked = autoSpeed;
    $("speedBox").hidden = autoSpeed;
    const sp = autoSpeed ? (s.speedMs ?? 5) : p.speedMs;
    $("speed").value = sp; $("speedOut").textContent = `${fmt(sp)} m/s`;
    $("speedHint").textContent = s.recommendedSpeedMs ? `Recomendada para estas fotos: ${fmt(s.recommendedSpeedMs)} m/s.` : "";
    const timed = p.photoMode === "TIMED";
    $("modeTimed").classList.toggle("on", timed); $("modePoint").classList.toggle("on", !timed);
    $("modeHint").textContent = timed
      ? (s.photoIntervalS ? `Atenção: neste modo o drone NÃO fotografa sozinho. Voo contínuo; você precisa ligar a foto temporizada de ${Math.round(s.photoIntervalS)} s no DJI Fly ao chegar no primeiro ponto.` : "Atenção: neste modo o drone não fotografa sozinho; ligue a foto temporizada no DJI Fly.")
      : "Recomendado. O drone para e fotografa sozinho em cada ponto. Fotos mais nítidas; voo mais lento e mais partes.";
    $("battery").value = p.batteryMinutes; $("batteryOut").textContent = `${Math.round(p.batteryMinutes)} min`;
    // Área
    $("btnUndo").disabled = !undo.length;
    $("btnClear").disabled = !state.polygon.length;
    $("btnNoTakeoff").hidden = !state.takeoff;
    $("btnTakeoff").textContent = state.takeoff ? "Mover decolagem" : "Marcar decolagem";
    $("showPhotos").checked = !!state.showPhotos;
    $("useTerrain").checked = !!state.useTerrain;
    $("mapHint").textContent = placingTakeoff ? "Clique no mapa onde o drone vai decolar."
      : state.polygon.length < 3 ? `Clique no mapa para marcar os vértices da área. Arraste para mover; ${delHint}.`
      : `Arraste os vértices para ajustar. Clique perto de um lado para inserir um vértice; ${delHint}.`;
    // Resumo
    $("stats").innerHTML = (s.stats || []).map((x) => `<div class="stat"><b title="${esc(x.value)}">${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join("");
    $("warns").innerHTML = (s.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
    renderParts(s);
    renderChecklist(s);
    renderTerrain();
  }

  function renderParts(s) {
    const box = $("parts");
    const parts = s.valid ? s.parts : [];
    $("btnAll").hidden = parts.length < 2;
    if (!parts.length) { box.innerHTML = `<p class="status">Desenhe a área para gerar os arquivos.</p>`; return; }
    // Reaproveita os campos já existentes para não perder o foco ao digitar.
    const sig = parts.map((p) => `${p.index}:${p.fileName}`).join("|");
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML = parts.map((p) => `
        <div class="part" data-i="${p.index}">
          <div class="head"><b>Parte ${p.index + 1}</b><span class="meta"></span></div>
          <div class="row">
            <input type="text" class="grow" id="dji${p.index}" placeholder="Nome no DJI Fly (opcional)" aria-label="Nome do arquivo da missão no DJI Fly, parte ${p.index + 1}">
            <button type="button" class="primary" data-dl="${p.index}">Baixar KMZ</button>
          </div>
          <div class="status over-msg" hidden>Esta parte passa do tempo de bateria configurado.</div>
        </div>`).join("");
      box.querySelectorAll("input").forEach((inp) => {
        const i = inp.closest(".part").dataset.i;
        inp.value = state.djiNames[i] || "";
        inp.addEventListener("input", () => { state.djiNames[i] = inp.value.trim(); persist(); });
      });
      box.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => download(+b.dataset.dl)));
    }
    parts.forEach((p) => {
      const el = box.querySelector(`.part[data-i="${p.index}"]`);
      el.classList.toggle("over", p.overBudget);
      el.querySelector(".over-msg").hidden = !p.overBudget;
      el.querySelector(".meta").textContent = `linhas ${p.firstLine + 1}–${p.lastLine + 1} · ${p.duration} · ${p.photos} fotos · ${p.waypoints} pontos`;
    });
  }

  function renderChecklist(s) {
    const items = [
      state.takeoff ? "Decole no ponto de decolagem marcado no plano (as alturas são relativas a ele)." : "Decole perto do início do caminho (círculo verde): as alturas são relativas ao ponto de decolagem.",
      `DJI Fly › Segurança: altura de retorno ${s.rthAltitudeM ? `de pelo menos ${s.rthAltitudeM} m` : "acima do ponto mais alto da área + 30 m"}.`,
      `DJI Fly › Segurança: altitude máxima de pelo menos ${Math.ceil(s.maxAltRelM || Core.altitudeForGsd(state.params.gsdCm))} m.`,
      "Câmera: foto 12 MP, proporção 4:3, JPEG. Obturador 1/500 s ou mais rápido, se a luz permitir.",
      state.params.photoMode === "TIMED" && s.photoIntervalS ? `Foto temporizada a cada ${Math.round(s.photoIntervalS)} s: ligar ao chegar no primeiro ponto, desligar no fim.` : null,
      "Bateria carregada e cartão com espaço.",
      "Voo autorizado (SISANT/SARPAS) e área livre.",
    ].filter(Boolean);
    $("checklist").innerHTML = items.map((t) => `<li>${esc(t)}</li>`).join("");
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- Downloads ----------

  function saveBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function kmzFileName(i) {
    let n = (state.djiNames[i] || "").trim().split(/[\\/]/).pop();
    if (!n) return Core.kmzName(coreState(), elevation(), i);
    return n.toLowerCase().endsWith(".kmz") ? n : `${n}.kmz`;
  }
  function download(i) {
    const bytes = Core.kmzBytes(coreState(), elevation(), i);
    if (!bytes) { toast("Não há plano para baixar."); return; }
    const name = kmzFileName(i);
    saveBlob(new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)], { type: "application/vnd.google-earth.kmz" }), name);
    toast(`${name} baixado.`);
  }
  $("btnAll").addEventListener("click", async () => {
    for (const p of snap?.parts || []) { download(p.index); await new Promise((r) => setTimeout(r, 400)); }
  });

  // ---------- Controles ----------

  const bindRange = (id, fn) => $(id).addEventListener("input", (e) => fn(parseFloat(e.target.value)));
  bindRange("gsd", (v) => setParam("gsdCm", v));
  $("alt").addEventListener("change", (e) => {
    const h = parseFloat(e.target.value);
    if (h > 0) setParam("gsdCm", Math.round(Core.gsdForAltitude(h) * 100) / 100);
  });
  bindRange("front", (v) => setParam("frontOverlap", v / 100));
  bindRange("side", (v) => setParam("sideOverlap", v / 100));
  bindRange("margin", (v) => setParam("marginM", v));
  bindRange("angle", (v) => setParam("lineAngleDeg", v));
  $("autoAngle").addEventListener("change", (e) => setParam("lineAngleDeg", e.target.checked ? null : Math.round(snap?.autoAngleDeg ?? 0)));
  $("gridSingle").addEventListener("click", () => setParam("type", "SINGLE"));
  $("gridDouble").addEventListener("click", () => setParam("type", "DOUBLE"));
  bindRange("pitch", (v) => setParam("obliquePitchDeg", v));
  $("autoStart").addEventListener("change", (e) => setParam("startPoint", e.target.checked ? -1 : Math.max(0, snap?.startIndex ?? 0)));
  $("autoSpeed").addEventListener("change", (e) => setParam("speedMs", e.target.checked ? null : Math.max(1, Math.floor((snap?.recommendedSpeedMs ?? 5) * 10) / 10)));
  bindRange("speed", (v) => setParam("speedMs", v));
  $("modeTimed").addEventListener("click", () => setParam("photoMode", "TIMED"));
  $("modePoint").addEventListener("click", () => setParam("photoMode", "EACH_POINT"));
  bindRange("battery", (v) => setParam("batteryMinutes", v));
  $("showPhotos").addEventListener("change", (e) => { state.showPhotos = e.target.checked; changed(); });
  $("useTerrain").addEventListener("change", (e) => { state.useTerrain = e.target.checked; changed(); });
  $("btnTerrain").addEventListener("click", () => ensureTerrain(true));
  $("name").addEventListener("input", (e) => { state.name = e.target.value || "Plano"; changed(); });

  function setPlacing(on) { placingTakeoff = on; $("btnTakeoff").classList.toggle("on", on); render(); }
  $("btnTakeoff").addEventListener("click", () => setPlacing(!placingTakeoff));
  $("btnNoTakeoff").addEventListener("click", () => { pushUndo(); state.takeoff = null; changed(); });
  function doUndo() {
    const u = undo.pop(); if (!u) return;
    Object.assign(state, JSON.parse(u)); changed();
  }
  $("btnUndo").addEventListener("click", doUndo);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); doUndo(); }
    if (e.key === "Escape" && placingTakeoff) setPlacing(false);
  });

  // Limpar e Novo pedem confirmação na própria página (um segundo clique).
  function confirmClick(btn, label, action) {
    let armed = false, t = 0;
    const orig = btn.textContent;
    btn.addEventListener("click", () => {
      if (!armed) { armed = true; btn.textContent = label; btn.classList.add("on"); t = setTimeout(reset, 3000); return; }
      reset(); action();
    });
    function reset() { armed = false; clearTimeout(t); btn.textContent = orig; btn.classList.remove("on"); }
  }
  confirmClick($("btnClear"), "Confirmar limpeza", () => { pushUndo(); state.polygon = []; changed(); });
  confirmClick($("btnNew"), "Confirmar: novo plano", () => { state = blank(); undo = []; terrain.box = null; changed(); });

  $("btnSave").addEventListener("click", () => {
    const data = JSON.stringify({ app: "plano-mini4pro", version: 1, ...state }, null, 2);
    const base = Core.kmzName(coreState(), null, 0)?.replace(/_parte1\.kmz$/, "") || "plano";
    saveBlob(new Blob([data], { type: "application/json" }), `${base}.json`);
  });
  $("btnOpen").addEventListener("click", () => $("fileOpen").click());
  $("fileOpen").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.polygon)) throw new Error();
      state = fromSaved(d);
      undo = []; terrain.box = null;
      changed(); fit(); toast(`Plano “${state.name}” aberto.`);
    } catch { toast("Arquivo inválido: escolha um projeto salvo por esta página (.json)."); }
  });

  // Busca: coordenadas "lat, lon" ou nome de lugar (OpenStreetMap).
  $("search").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("searchInput").value.trim();
    if (!q) return;
    const m = q.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (m) {
      const la = parseFloat(m[1].replace(",", ".")), lo = parseFloat(m[2].replace(",", "."));
      if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) { map.flyTo({ center: [lo, la], zoom: 16 }); return; }
    }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=pt-BR&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!j.length) { toast("Lugar não encontrado."); return; }
      const [s, n, w, ea] = j[0].boundingbox.map(Number);
      map.fitBounds([[w, s], [ea, n]], { maxZoom: 16, padding: 40 });
    } catch { toast("Busca indisponível. Confira a internet."); }
  });
  $("btnLocate").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Localização indisponível neste navegador."); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16 }),
      () => toast("Não foi possível obter a localização."), { enableHighAccuracy: true, timeout: 10000 });
  });

  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // Calcula já ao abrir (área salva), sem depender do mapa carregar.
  render();
  changed(false);
})();

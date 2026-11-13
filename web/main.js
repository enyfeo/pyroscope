import "../pof_explorer/static/vendor/leaflet.js";
import "../pof_explorer/static/vendor/leaflet.css";
import "../pof_explorer/static/style.css";
import "./style.css";
import { geoMercator, geoPath } from "d3-geo";
import geography from "../pof_explorer/static/countries.geojson?url";
import { DEFAULT_SOURCE, sourceURL } from "./data.js";

const L = window.L;
const element = id => document.getElementById(id);
let worker, layer, timer, times = [], currentRun, revision = 0, pointRevision = 0, token = 0, older = 0;
let sequence = 0;
const pending = new Map();
const status = (message, error = false) => {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
};
const controls = disabled => {
  for (const id of ["run", "step", "play", "previous", "next"]) element(id).disabled = disabled;
};
const formatTime = time => new Date(time).toLocaleString(undefined, {
  timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function call(method, ...args) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args, token });
  });
}
function stop() {
  clearInterval(timer);
  timer = null;
  element("play").textContent = "Play forecast";
}
function resetWorker() {
  worker?.terminate();
  for (const request of pending.values()) request.reject(new Error("Connection refreshed."));
  pending.clear();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  worker.onerror = event => {
    const error = new Error(`Zarr worker failed: ${event.message || "check browser console"}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    stop();
    controls(true);
    status(error.message, true);
  };
}
const map = L.map("map", { maxZoom: 10, minZoom: 1 }).setView([15, 5], 2);
map.createPane("basemap").style.zIndex = 150;
let countries;
const BaseMapLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    requestAnimationFrame(() => {
      try {
        const context = canvas.getContext("2d");
        context.fillStyle = "#dddddd";
        context.fillRect(0, 0, 256, 256);
        if (countries) {
          const worldSize = 256 * 2 ** coords.z;
          const projection = geoMercator()
            .scale(worldSize / (2 * Math.PI))
            .translate([worldSize / 2 - coords.x * 256, worldSize / 2 - coords.y * 256])
            .precision(.5);
          const path = geoPath(projection, context);
          context.beginPath();
          path(countries);
          context.fillStyle = "#f7f7f3";
          context.fill();
          context.strokeStyle = "#b3bfbc";
          context.lineWidth = .7;
          context.stroke();
        }
        done(null, canvas);
      } catch (error) {
        done(error, canvas);
      }
    });
    return canvas;
  },
});
async function loadBasemap() {
 try {
  const response = await fetch(geography);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  countries = await response.json();
  new BaseMapLayer({
    pane: "basemap",
    bounds: [[-85.051129, -180], [85.051129, 180]],
    attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a> (public domain)',
  }).addTo(map);
 } catch (error) {
   status(`Basemap unavailable: ${error.message}`, true);
 }
}
loadBasemap();

const ProbabilityLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const viewToken = token;
    call("tile", currentRun, Number(element("step").value), coords.z, coords.x, coords.y).then(pixels => {
      if (viewToken !== token) { done(null, canvas); return; }
      canvas.getContext("2d").putImageData(new ImageData(pixels, 256, 256), 0, 0);
      done(null, canvas);
    }).catch(error => done(error, canvas));
    return canvas;
  },
});

function clearForecast() {
  token++;
  worker?.postMessage({ method: "generation", token });
  pointRevision++;
  map.closePopup();
  if (layer) { map.removeLayer(layer); layer = null; }
}
function render() {
  clearForecast();
  const label = `${formatTime(times[Number(element("step").value)])} UTC`;
  element("valid").textContent = label;
  element("map-date").textContent = label;
  const thisLayer = new ProbabilityLayer({
    opacity: Number(element("opacity").value) / 100, maxZoom: 10,
    bounds: [[-85.051129, -180], [85.051129, 180]], keepBuffer: 0,
  });
  let failed = false;
  thisLayer.on("tileerror", event => {
    if (layer !== thisLayer) return;
    failed = true;
    stop();
    status(`Forecast could not load: ${event.error.message} Use Connect / refresh data to retry.`, true);
  });
  thisLayer.on("load", () => {
    if (layer === thisLayer && !failed) status("Forecast ready. Click the map for a grid-cell forecast time series.");
  });
  layer = thisLayer;
  status("Reading and decoding forecast chunks...");
  layer.addTo(map);
}
async function selectRun() {
  const version = ++revision;
  stop();
  controls(true);
  clearForecast();
  times = [];
  element("valid").textContent = "Loading forecast...";
  element("map-date").textContent = "";
  const selected = Number(element("run").value);
  try {
    const forecast = await call("forecast", selected);
    if (version !== revision) return;
    if (!forecast.length) throw new Error("This run has no forecast times.");
    times = forecast;
    currentRun = selected;
    element("step").max = times.length - 1;
    element("step").value = 0;
    controls(false);
    element("older").disabled = older === 0;
    render();
  } catch (error) {
    if (version !== revision) return;
    status(error.message, true);
    element("run").disabled = false;
  }
}
function appendRuns(catalog) {
  older = catalog.older;
  const options = catalog.runs.slice().reverse().map(run => new Option(formatTime(run.time), run.index));
  element("run").append(...options);
  element("older").disabled = older === 0;
  element("older").textContent = older ? `Load older runs (${older} remaining)` : "All runs loaded";
}
async function initialize() {
  const version = ++revision;
  stop();
  controls(true);
  element("older").disabled = true;
  clearForecast();
  times = [];
  element("valid").textContent = "Awaiting data";
  element("map-date").textContent = "";
  element("run").replaceChildren(new Option("Connecting...", ""));
  resetWorker();
  status("Checking direct Zarr access and reading fresh metadata...");
  try {
    const source = sourceURL(element("source").value, location.protocol);
    const catalog = await call("open", source);
    if (version !== revision) return;
    element("run").replaceChildren();
    appendRuns(catalog);
    if (!catalog.runs.length) throw new Error("No forecast runs available.");
    element("connection").textContent = `Connected directly to Zarr. Metadata read ${new Date().toLocaleTimeString()}. Refresh to discover updates.`;
    await selectRun();
  } catch (error) {
    if (version !== revision) return;
    status(error.message, true);
  }
}
const percent = value => `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}%`;
const shortDate = time => new Date(time).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short" });
function svg(name, attributes, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function seriesChart(series, validTimes, selected) {
  const width = 320, height = 170, left = 46, right = 10, top = 12, bottom = 28;
  const values = series.probabilities;
  const peak = Math.max(...values.filter(value => value !== null), .0001);
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const maximum = [1, 2, 5, 10].map(factor => factor * magnitude).find(limit => limit >= peak);
  const x = index => left + (values.length > 1 ? index / (values.length - 1) : .5) * (width - left - right);
  const y = value => top + (1 - value / maximum) * (height - top - bottom);
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "series-chart", role: "img",
    "aria-label": `Daily probability of fire at each forecast time: ${values.map((value, index) =>
      `${formatTime(validTimes[index])} UTC ${value === null ? "no data" : percent(value)}`).join("; ")}.` });
  for (const fraction of [0, .5, 1]) {
    chart.append(svg("line", { x1: left, x2: width - right, y1: y(maximum * fraction), y2: y(maximum * fraction), class: "grid" }));
    chart.append(svg("text", { x: left - 6, y: y(maximum * fraction) + 3, "text-anchor": "end" }, percent(maximum * fraction)));
  }
  for (const index of new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])) {
    const anchor = values.length > 1 && index === 0 ? "start" : index === values.length - 1 && index ? "end" : "middle";
    chart.append(svg("text", { x: x(index), y: height - 8, "text-anchor": anchor }, shortDate(validTimes[index])));
  }
  chart.append(svg("line", { x1: x(selected), x2: x(selected), y1: top, y2: height - bottom, class: "selected" }));
  let path = "";
  values.forEach((value, index) => {
    if (value === null) return;
    path += `${index && values[index - 1] !== null ? "L" : "M"}${x(index)},${y(value)}`;
  });
  chart.append(svg("path", { d: path, class: "series" }));
  values.forEach((value, index) => {
    if (value === null) return;
    const dot = svg("circle", { cx: x(index), cy: y(value), r: index === selected ? 4.5 : 3, class: "point" });
    dot.append(svg("title", {}, `${formatTime(validTimes[index])} UTC: ${percent(value)}`));
    chart.append(dot);
  });
  return chart;
}
map.on("click", async event => {
  if (!times.length || element("step").disabled) return;
  const requestId = ++pointRevision;
  const selected = Number(element("step").value), validTimes = times;
  const popup = L.popup({ minWidth: 320, maxWidth: 340 }).setLatLng(event.latlng)
    .setContent("Reading forecast time series...").openOn(map);
  try {
    const series = await call("series", currentRun, event.latlng.lat, event.latlng.lng);
    if (requestId !== pointRevision) return;
    const content = document.createElement("div");
    content.className = "series-popup";
    const heading = document.createElement("strong");
    heading.textContent = `Grid centre ${series.lat.toFixed(3)}, ${series.lon.toFixed(3)}`;
    const current = series.probabilities[selected];
    const summary = document.createElement("p");
    summary.textContent = `${current === null ? "No data" : `${percent(current)} daily probability`} on ${formatTime(validTimes[selected])} UTC.`;
    content.append(heading, summary);
    if (series.probabilities.every(value => value === null)) {
      const empty = document.createElement("p");
      empty.textContent = "No data at this grid cell for the selected forecast.";
      content.append(empty);
    } else {
      content.append(seriesChart(series, validTimes, selected));
      const note = document.createElement("p");
      note.textContent = "Forecast evolution for the selected run. Gaps indicate no data.";
      content.append(note);
    }
    popup.setContent(content);
  } catch (error) {
    if (requestId !== pointRevision) return;
    const content = document.createElement("div");
    content.textContent = error.message;
    popup.setContent(content);
    status(error.message, true);
  }
});
element("run").addEventListener("change", selectRun);
element("step").addEventListener("input", () => { stop(); render(); });
element("opacity").addEventListener("input", () => layer?.setOpacity(Number(element("opacity").value) / 100));
function advance(delta) {
  element("step").value = (Number(element("step").value) + delta + times.length) % times.length;
  render();
}
element("previous").addEventListener("click", () => { stop(); advance(-1); });
element("next").addEventListener("click", () => { stop(); advance(1); });
element("play").addEventListener("click", () => {
  if (timer) { stop(); return; }
  element("play").textContent = "Pause forecast";
  timer = setInterval(() => { if (!layer?.isLoading()) advance(1); }, 1400);
});
element("older").addEventListener("click", async () => {
  const version = revision;
  element("older").disabled = true;
  try {
    const catalog = await call("runs", older);
    if (version === revision) appendRuns(catalog);
  } catch (error) {
    if (version !== revision) return;
    status(error.message, true);
    element("older").disabled = false;
  }
});
element("source").value = import.meta.env.VITE_ZARR_URL || DEFAULT_SOURCE;
element("source-form").addEventListener("submit", event => { event.preventDefault(); initialize(); });
initialize();

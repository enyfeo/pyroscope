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
const status = (message, error = false, loading = false) => {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
  element("map-status-text").textContent = message;
  element("map-status").classList.toggle("error", error);
  element("map-status").classList.toggle("loading", loading);
  element("map-status").classList.toggle("ready", !error && !loading);
  if (error) console.error(`PyroScope: ${message}`);
};
const controls = disabled => {
  for (const id of ["run", "step", "play", "previous", "next"]) element(id).disabled = disabled;
  for (const button of element("timeline-steps").querySelectorAll("button")) button.disabled = disabled;
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
  element("play").setAttribute("aria-label", "Play forecast");
  element("play").classList.remove("playing");
}
function updateTimeline() {
  const selected = Number(element("step").value);
  element("previous").disabled = element("step").disabled || selected <= 0;
  element("next").disabled = element("step").disabled || selected >= times.length - 1;
  element("play").disabled = element("step").disabled || times.length < 2;
  element("timeline-issued").textContent = element("run").selectedOptions[0]?.textContent || "Awaiting data";
}
function updateTimelineSteps() {
  const container = element("timeline-steps");
  const scrollLeft = container.scrollLeft;
  container.replaceChildren();
  times.forEach((time, index) => {
    const button = document.createElement("button");
    const date = new Date(time).toLocaleDateString(undefined, {
      timeZone: "UTC", month: "short", day: "numeric",
    });
    button.type = "button";
    button.className = "timeline-stop";
    button.textContent = date;
    button.title = `${formatTime(time)} UTC`;
    button.setAttribute("aria-label", `Show forecast valid at ${formatTime(time)} UTC`);
    button.setAttribute("aria-pressed", String(index === Number(element("step").value)));
    if (index === Number(element("step").value)) button.classList.add("selected");
    button.disabled = element("step").disabled;
    button.addEventListener("click", () => {
      stop();
      element("step").value = index;
      render();
    });
    container.append(button);
  });
  container.scrollLeft = scrollLeft;
  const selected = container.querySelector(".selected");
  if (selected) {
    const viewport = container.getBoundingClientRect();
    const selectedBounds = selected.getBoundingClientRect();
    if (selectedBounds.left < viewport.left) container.scrollLeft -= viewport.left - selectedBounds.left;
    else if (selectedBounds.right > viewport.right) container.scrollLeft += selectedBounds.right - viewport.right;
  }
  updateTimeline();
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
    console.error(error);
    status("Forecast worker stopped unexpectedly. Refresh the data connection to retry.", true);
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
   console.error("Basemap unavailable:", error);
   status("Basemap could not be loaded.", true);
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
  if (!times.length) return;
  clearForecast();
  const selected = Number(element("step").value);
  const label = `${formatTime(times[selected])} UTC`;
  element("valid").textContent = label;
  element("map-date").textContent = label;
  updateTimelineSteps();
  const thisLayer = new ProbabilityLayer({
    opacity: Number(element("opacity").value) / 100, maxZoom: 10,
    bounds: [[-85.051129, -180], [85.051129, 180]], keepBuffer: 0,
  });
  let failed = false;
  thisLayer.on("tileerror", event => {
    if (layer !== thisLayer) return;
    failed = true;
    stop();
    console.error("Forecast tile could not load:", event.error);
    status("Forecast data could not be loaded. Check the connection and use Settings & info to retry.", true);
  });
  thisLayer.on("load", () => {
    if (layer === thisLayer && !failed) status("Forecast ready. Select a map cell to inspect its time series.");
  });
  layer = thisLayer;
  status("Loading forecast data...", false, true);
  layer.addTo(map);
}
async function selectRun() {
  const version = ++revision;
  stop();
  controls(true);
  clearForecast();
  times = [];
  updateTimelineSteps();
  element("valid").textContent = "Loading forecast...";
  element("map-date").textContent = "";
  element("timeline-issued").textContent = element("run").selectedOptions[0]?.textContent || "Loading...";
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
    updateTimelineSteps();
    element("older").disabled = older === 0;
    render();
  } catch (error) {
    if (version !== revision) return;
    console.error("Forecast times could not be read:", error);
    status("Forecast times could not be loaded. Check the data connection and try again.", true);
    element("run").disabled = false;
    updateTimelineSteps();
  }
}
function appendRuns(catalog) {
  older = catalog.older;
  const options = catalog.runs.slice().reverse().map(run => new Option(formatTime(run.time), run.index));
  element("run").append(...options);
  element("older").disabled = older === 0;
  element("older").textContent = older ? `Load older runs (${older} remaining)` : "All runs loaded";
  updateTimeline();
}
async function initialize() {
  const version = ++revision;
  stop();
  controls(true);
  element("older").disabled = true;
  clearForecast();
  times = [];
  updateTimelineSteps();
  element("valid").textContent = "Awaiting data";
  element("map-date").textContent = "";
  element("timeline-issued").textContent = "Awaiting data";
  element("connection").textContent = "";
  element("run").replaceChildren(new Option("Connecting...", ""));
  resetWorker();
  status("Connecting to forecast data...", false, true);
  try {
    const source = sourceURL(element("source").value, location.protocol);
    const catalog = await call("open", source);
    if (version !== revision) return;
    element("run").replaceChildren();
    appendRuns(catalog);
    if (!catalog.runs.length) throw new Error("No forecast runs available.");
    element("connection").textContent = "Connected to the forecast data source.";
    await selectRun();
  } catch (error) {
    if (version !== revision) return;
    console.error("Forecast data connection failed:", error);
    status("Could not connect to forecast data. Check the source URL or retry the connection.", true);
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
    content.textContent = "Could not load the forecast time series for this cell.";
    popup.setContent(content);
    console.error("Grid-cell forecast series could not be loaded:", error);
    status("Could not load grid-cell forecast data.", true);
  }
});
element("run").addEventListener("change", selectRun);
element("step").addEventListener("input", () => { stop(); render(); });
element("opacity").addEventListener("input", () => {
  const opacity = Number(element("opacity").value);
  element("opacity-value").textContent = `${opacity}%`;
  layer?.setOpacity(opacity / 100);
});
function advance(delta) {
  const current = Number(element("step").value);
  const next = current + delta;
  if (next < 0 || next >= times.length) {
    if (delta > 0) stop();
    return;
  }
  element("step").value = next;
  render();
  if (delta > 0 && next === times.length - 1) stop();
}
element("previous").addEventListener("click", () => { stop(); advance(-1); });
element("next").addEventListener("click", () => { stop(); advance(1); });
element("play").addEventListener("click", () => {
  if (timer) { stop(); return; }
  if (Number(element("step").value) >= times.length - 1) element("step").value = 0;
  render();
  element("play").textContent = "Pause forecast";
  element("play").setAttribute("aria-label", "Pause forecast");
  element("play").classList.add("playing");
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
    console.error("Older forecast runs could not be loaded:", error);
    status("Could not load older forecast runs. Check the connection and retry.", true);
    element("older").disabled = false;
  }
});
element("source").value = import.meta.env.VITE_ZARR_URL || DEFAULT_SOURCE;
element("source-form").addEventListener("submit", event => { event.preventDefault(); initialize(); });
if (matchMedia("(max-width: 640px)").matches) element("legend").open = false;
initialize();

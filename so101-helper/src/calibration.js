import './shell.js';
import { inspectCalibration } from './calibration-core.js';

const fileInput = document.querySelector('#calibration-file');
const dropZone = document.querySelector('#calibration-drop');
const chooseButton = document.querySelector('#select-calibration');
const loadExampleButton = document.querySelector('#load-example');
const grid = document.querySelector('#joint-grid');
const summary = document.querySelector('#calibration-summary');
const messages = document.querySelector('#calibration-messages');

const formatDegrees = (value) => `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}°`;

function setMessages(result) {
  const items = [...result.errors, ...result.warnings];
  messages.hidden = items.length === 0;
  messages.classList.toggle('is-success', items.length === 0);
  messages.replaceChildren();
  if (!items.length) return;

  const lead = document.createElement('strong');
  lead.textContent = result.errors.length ? 'Review.' : 'Notes.';
  const list = document.createElement('ul');
  for (const text of items) {
    const item = document.createElement('li');
    item.textContent = text;
    list.append(item);
  }
  messages.append(lead, list);
}

function makeJointCard(joint) {
  const article = document.createElement('article');
  article.className = 'joint-card';

  const head = document.createElement('div');
  head.className = 'joint-head';
  const title = document.createElement('h3');
  title.className = 'joint-name';
  title.textContent = joint.label;
  const motorId = document.createElement('span');
  motorId.className = 'motor-id';
  motorId.textContent = `MOTOR ${joint.id}`;
  head.append(title, motorId);

  const stats = document.createElement('div');
  stats.className = 'joint-stats';
  stats.innerHTML = `<span>RAW ${joint.range_min}–${joint.range_max}</span><span>OFFSET ${joint.homing_offset}</span><span>SPAN ${joint.measuredSpan.toFixed(1)}°</span>`;

  const rail = document.createElement('div');
  rail.className = 'joint-rail';
  rail.setAttribute('aria-label', `Usable range ${formatDegrees(joint.usableMin)} to ${formatDegrees(joint.usableMax)}`);
  const track = document.createElement('span');
  track.className = 'rail-track';
  const measured = document.createElement('span');
  measured.className = 'rail-measured';
  measured.style.left = `${joint.rail.measuredLeft}%`;
  measured.style.width = `${joint.rail.measuredWidth}%`;
  const usable = document.createElement('span');
  usable.className = 'rail-usable';
  usable.style.left = `${joint.rail.usableLeft}%`;
  usable.style.width = `${joint.rail.usableWidth}%`;
  const zero = document.createElement('span');
  zero.className = 'rail-zero';
  const minCap = document.createElement('span');
  minCap.className = 'rail-cap';
  minCap.style.left = `${joint.rail.minCap}%`;
  const maxCap = document.createElement('span');
  maxCap.className = 'rail-cap';
  maxCap.style.left = `${joint.rail.maxCap}%`;
  rail.append(track, measured, usable, zero, minCap, maxCap);

  const scale = document.createElement('div');
  scale.className = 'joint-scale';
  scale.innerHTML = `<span>−180°</span><strong>${formatDegrees(joint.usableMin)} → ${formatDegrees(joint.usableMax)}</strong><span>+180°</span>`;

  article.append(head, stats, rail, scale);
  if (joint.warnings.length) {
    const note = document.createElement('div');
    note.className = 'joint-warning';
    note.textContent = joint.warnings.join(' ');
    article.append(note);
  }
  return article;
}

function renderCalibration(data, sourceLabel) {
  const result = inspectCalibration(data);
  const state = result.errors.length ? 'error' : result.warnings.length ? 'warning' : 'valid';
  summary.dataset.state = state;
  document.querySelector('#summary-status').textContent = result.errors.length ? 'Invalid' : result.warnings.length ? 'Review' : 'Valid';
  document.querySelector('#summary-motors').textContent = `${result.joints.length} / 6`;
  document.querySelector('#summary-warnings').textContent = String(result.errors.length + result.warnings.length);
  document.querySelector('#summary-source').textContent = sourceLabel;
  grid.replaceChildren(...result.joints.map(makeJointCard));
  if (!result.joints.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No motors.';
    grid.append(empty);
  }
  setMessages(result);
}

async function readFile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    renderCalibration(data, file.name);
  } catch (error) {
    renderCalibration(null, file.name);
    messages.hidden = false;
    messages.textContent = `JSON error: ${error.message}`;
  }
}

chooseButton.addEventListener('click', (event) => { event.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', () => readFile(fileInput.files[0]));
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
});
for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); });
}
dropZone.addEventListener('drop', (event) => readFile(event.dataTransfer.files[0]));
loadExampleButton.addEventListener('click', async () => {
  const response = await fetch(`${import.meta.env.BASE_URL}examples/so101-calibration.example.json`);
  renderCalibration(await response.json(), 'Synthetic example');
});

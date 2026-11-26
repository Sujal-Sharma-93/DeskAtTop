/**
 * Weather status widget.
 *
 * DeskAtTop has no weather provider or network permission in this build, so the
 * panel deliberately renders an explicit unavailable state instead of inventing
 * conditions. If a provider is added later, only this module needs to change.
 */
export interface WeatherPanel {
  element: HTMLElement;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function createWeatherPanel(): WeatherPanel {
  const root = element('div', 'weather-panel');
  root.setAttribute('aria-label', 'Weather unavailable');

  const icon = element('span', 'weather-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3l18 18" />
      <path d="M7.5 18h9a4 4 0 0 0 .6-7.96" />
      <path d="M6.2 14.1A4 4 0 0 1 7.5 6.2a5 5 0 0 1 8.2-1.4" />
    </svg>`;

  const details = element('div', 'weather-details');
  const temp = element('div', 'weather-temp');
  temp.textContent = '—';
  temp.title = 'Current temperature unavailable';
  const condition = element('div', 'weather-condition');
  condition.textContent = 'No weather data';
  const location = element('div', 'weather-location');
  location.textContent = 'Location not configured';

  const note = element('p', 'weather-note');
  note.textContent = 'No weather source is available in this build.';

  details.append(temp, condition, location);
  root.append(icon, details, note);

  return {
    element: root,
    destroy: () => root.remove(),
  };
}

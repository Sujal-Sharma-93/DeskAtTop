const layer = new URLSearchParams(window.location.search).get('layer') ?? 'overlay';
document.body.dataset.layer = layer;

if (layer === 'popup') {
  void import('./popup');
} else if (layer === 'wallpaper') {
  void import('./wallpaper');
} else if (layer === 'overlay') {
  void import('./main');
}

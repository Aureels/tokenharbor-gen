const WEBGL = [
  ['Intel Inc.', 'Intel Iris OpenGL Engine'],
  ['Intel Inc.', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)']
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 }
];

const CORES = [4, 6, 8, 12, 16];
const MEMORY = [4, 8];

const pick = list => list[Math.floor(Math.random() * list.length)];

export function randomProfile() {
  const [vendor, renderer] = pick(WEBGL);
  return {
    vendor,
    renderer,
    viewport: pick(VIEWPORTS),
    hardwareConcurrency: pick(CORES),
    deviceMemory: pick(MEMORY)
  };
}

export function applyStealth(context, profile = randomProfile()) {
  return context.addInitScript(spoof => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => spoof.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => spoof.deviceMemory });

    const patch = (proto, param, value) => {
      if (!proto || !proto.getParameter) return;
      const original = proto.getParameter;
      proto.getParameter = function (name) {
        if (name === param) return value;
        return original.apply(this, arguments);
      };
    };

    patch(window.WebGLRenderingContext?.prototype, 37445, spoof.vendor);
    patch(window.WebGLRenderingContext?.prototype, 37446, spoof.renderer);
    patch(window.WebGL2RenderingContext?.prototype, 37445, spoof.vendor);
    patch(window.WebGL2RenderingContext?.prototype, 37446, spoof.renderer);
  }, profile);
}

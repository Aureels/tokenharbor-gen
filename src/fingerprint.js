export function applyStealth(context) {
  return context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    const spoof = (proto, param, value) => {
      if (!proto || !proto.getParameter) return;
      const original = proto.getParameter;
      proto.getParameter = function (name) {
        if (name === param) return value;
        return original.apply(this, arguments);
      };
    };

    spoof(window.WebGLRenderingContext?.prototype, 37445, 'Intel Inc.');
    spoof(window.WebGLRenderingContext?.prototype, 37446, 'Intel Iris OpenGL Engine');
    spoof(window.WebGL2RenderingContext?.prototype, 37445, 'Intel Inc.');
    spoof(window.WebGL2RenderingContext?.prototype, 37446, 'Intel Iris OpenGL Engine');
  });
}

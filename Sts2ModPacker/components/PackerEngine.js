import React, { useRef, useImperativeHandle, forwardRef } from 'react';
import { WebView } from 'react-native-webview';

const PackerEngine = forwardRef((props, ref) => {
  const webViewRef = useRef(null);

  useImperativeHandle(ref, () => ({
    processAtlases: (atlasBase64s, bindings) => {
      const message = {
        type: 'PROCESS',
        atlasBase64s,
        bindings
      };
      webViewRef.current.postMessage(JSON.stringify(message));
    },
    buildLightAtlas: (width, height, cards) => {
      const message = {
        type: 'BUILD_ATLAS',
        width,
        height,
        cards // [{ imageBase64, x, y, w, h }]
      };
      webViewRef.current.postMessage(JSON.stringify(message));
    }
  }));

  const html = `
    <html>
    <body>
      <canvas id="canvas"></canvas>
      <script>
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');

        window.addEventListener('message', async (event) => {
          const msg = JSON.parse(event.data);
          const { type } = msg;

          if (type === 'BUILD_ATLAS') {
            const { width, height, cards } = msg;
            canvas.width = width;
            canvas.height = height;
            ctx.clearRect(0, 0, width, height);

            for (const c of cards) {
              // Cards are already cropped+resized to exact dimensions — just paste at position
              const img = await loadImage('data:image/png;base64,' + c.imageBase64);
              ctx.drawImage(img, c.x, c.y, c.w, c.h);
            }

            const dataUrl = canvas.toDataURL('image/png');
            const base64 = dataUrl.split(',')[1];
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'ATLAS_READY',
              atlasBase64: base64,
              width: canvas.width,
              height: canvas.height
            }));
            return;
          }

          const { atlasBase64s, bindings } = msg;
          if (type === 'PROCESS') {
            const results = {};
            
            // Process dynamically passed atlases
            for (const atlasName of Object.keys(atlasBase64s)) {
              if (!atlasBase64s[atlasName]) continue;
              
              const img = await loadImage('data:image/png;base64,' + atlasBase64s[atlasName]);
              canvas.width = img.width;
              canvas.height = img.height;
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0);
              
              // Draw bound images for this atlas
              const atlasBindings = bindings.filter(b => b.atlas === atlasName);
              for (const b of atlasBindings) {
                const userImg = await loadImage(b.userImageBase64);
                
                // Calculate render size of user image inside 1000x1000 wrapper (matches CropperModal logic)
                let renderW, renderH;
                if (userImg.width > userImg.height) {
                  renderW = 1000;
                  renderH = 1000 * (userImg.height / userImg.width);
                } else {
                  renderH = 1000;
                  renderW = 1000 * (userImg.width / userImg.height);
                }
                
                const t = b.transform || { x: 0, y: 0, scale: 1 };
                
                // UI Space top-left relative to center (500, 500)
                const uiX = (-renderW / 2) * t.scale + t.x;
                const uiY = (-renderH / 2) * t.scale + t.y;
                
                // Atlas card center
                const cx = b.x + b.w / 2;
                const cy = b.y + b.h / 2;
                
                // Map to Atlas Space (multiplier 2.0 since mask was w*0.5, h*0.5)
                const atlasX = cx + uiX * 2.0;
                const atlasY = cy + uiY * 2.0;
                const drawW = renderW * t.scale * 2.0;
                const drawH = renderH * t.scale * 2.0;
                
                ctx.save();
                ctx.beginPath();
                ctx.rect(b.x, b.y, b.w, b.h);
                ctx.clip();
                ctx.drawImage(userImg, atlasX, atlasY, drawW, drawH);
                ctx.restore();
              }
              
              // Export as WebP (lossy 1.0)
              let dataUrl = canvas.toDataURL('image/webp', 1.0);
              let isPngFallback = false;
              
              // iOS WebKit might fallback to PNG if WebP is not supported (pre-iOS 16.4)
              if (dataUrl.startsWith('data:image/png')) {
                isPngFallback = true;
                dataUrl = canvas.toDataURL('image/png'); // Force pure PNG for safe fallback
              }

              const processedBase64 = dataUrl.split(',')[1];
              results[atlasName] = {
                base64: processedBase64,
                width: canvas.width,
                height: canvas.height,
                isPngFallback: isPngFallback
              };
            }
            
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SUCCESS', results }));
          }
        });

        function loadImage(src) {
          return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = src;
          });
        }
      </script>
    </body>
    </html>
  `;

  return (
    <WebView
      ref={webViewRef}
      style={{ width: 0, height: 0, position: 'absolute' }}
      originWhitelist={['*']}
      source={{ html }}
      onMessage={(event) => {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'SUCCESS') {
          props.onProcessingComplete(data.results);
        } else if (data.type === 'ATLAS_READY') {
          props.onLightAtlasReady(data);
        }
      }}
    />
  );
});

export default PackerEngine;

import { defineConfig } from 'vite'

// base: './' — 상대 경로로 빌드해서 어느 호스팅에 올려도 그대로 동작한다.
// GitHub Pages 하위 경로(/namparang/), Cloudflare Pages, Netlify 모두 수정 없이 배포.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    // 데이터 JSON은 public/ 에서 그대로 복사되므로 해시가 붙지 않는다.
    // 앱이 상대 경로로 fetch 하려면 이게 필요하다.
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    open: true,
  },
})

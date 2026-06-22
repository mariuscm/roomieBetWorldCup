import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'fs'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'generate-version-json',
      closeBundle() {
        try {
          const pkgPath = path.resolve('package.json')
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
          const distDir = path.resolve('dist')
          if (!fs.existsSync(distDir)) {
            fs.mkdirSync(distDir, { recursive: true })
          }
          fs.writeFileSync(
            path.resolve(distDir, 'version.json'),
            JSON.stringify({ version: pkg.version }),
            'utf-8'
          )
          console.log(`\x1b[32m✓\x1b[0m generated dist/version.json (v${pkg.version})`)
        } catch (e) {
          console.error('Error generating version.json:', e)
        }
      }
    }
  ],
})

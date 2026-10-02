// Run after `npx cap add android` / `ios` (npm run android / ios does it for you): forces landscape in the native projects.
const fs = require('fs');
const edit = (f, fn) => { if (fs.existsSync(f)) { const s = fs.readFileSync(f, 'utf8'), o = fn(s); if (o !== s) { fs.writeFileSync(f, o); console.log('landscape set in', f); } } };
edit('android/app/src/main/AndroidManifest.xml', s => /screenOrientation/.test(s) ? s : s.replace('<activity', '<activity android:screenOrientation="sensorLandscape"'));
edit('ios/App/App/Info.plist', s => s.replace(/(<key>UISupportedInterfaceOrientations(?:~ipad)?<\/key>\s*<array>)[\s\S]*?(<\/array>)/g,
  '$1\n\t\t<string>UIInterfaceOrientationLandscapeLeft</string>\n\t\t<string>UIInterfaceOrientationLandscapeRight</string>\n\t$2'));

const fs=require('fs');fs.rmSync('www',{recursive:true,force:true});fs.mkdirSync('www');
for(const f of fs.readdirSync('.'))if(/\.(html|js|png|webmanifest)$/.test(f)&&!['prep.js'].includes(f))fs.copyFileSync(f,'www/'+f);
console.log('www ready');

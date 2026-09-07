/* Node runner for GitHub Actions.
   Shims the browser localStorage the engine expects onto a state.json file,
   loads the engine, and runs exactly one trading round.
   The GitHub Actions runner has open network access, so the engine can
   reach Polymarket's Gamma API from here (it cannot from the desktop sandbox). */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'state.json');

globalThis.localStorage = {
  getItem: function(){ try { return fs.readFileSync(FILE, 'utf8'); } catch (e) { return null; } },
  setItem: function(k, v){ fs.writeFileSync(FILE, v); },
  removeItem: function(){ try { fs.unlinkSync(FILE); } catch (e) {} }
};

// engine.js guards all browser calls behind `typeof document==='undefined'`,
// so requiring it here does not try to touch the DOM.
require('./engine.js');

(async function(){
  try {
    const res = await globalThis.__DMPL.runRound();
    if (res && res.error) {
      console.error('round reported an error (likely could not reach Polymarket); state left unchanged');
      process.exit(1);
    }
    console.log('round complete:', JSON.stringify(res));
  } catch (e) {
    console.error('runner failed:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();

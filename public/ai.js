// On-device AI: runs fully in the browser, no internet, no API.
// Step 1 (day 2): weighted keyword triage. Hindi/Hinglish words included.
const RULES = [
  { cat: 'sos',     prio: 3, words: ['sos','help me','emergency','trapped','drowning','fire','collapsed','attack','dying','madad','bachao','bachaao','aag'] },
  { cat: 'medical', prio: 2, words: ['bleeding','injured','injury','hurt','unconscious','broken','pain','medicine','doctor','ambulance','pregnant','insulin','breathing','dawai','ghayal','chot'] },
  { cat: 'water',   prio: 1, words: ['water','food','hungry','thirsty','milk','baby','paani','khana','bhook'] },
  { cat: 'shelter', prio: 1, words: ['shelter','roof','blanket','cold','stuck','road blocked','evacuate','safe place','ghar','rescue'] },
];

function triage(text) {
  const t = text.toLowerCase();
  let best = { cat: 'general', prio: 0, score: 0 };
  for (const r of RULES) {
    const score = r.words.filter(w => t.includes(w)).length;
    if (score && (r.prio > best.prio || (r.prio === best.prio && score > best.score)))
      best = { cat: r.cat, prio: r.prio, score };
  }
  if (/!{2,}/.test(text) && best.prio < 3 && best.prio > 0) best.prio += 1; // urgency boost
  return { cat: best.cat, prio: Math.min(best.prio, 3) };
}

// Situation summary for rescuers: counts + latest urgent messages.
function summarize(msgs) {
  if (!msgs.length) return 'No messages yet.';
  const n = c => msgs.filter(m => m.cat === c).length;
  const urgent = msgs.filter(m => m.prio >= 2).slice(-3);
  let s = `${msgs.length} messages from ${new Set(msgs.map(m => m.from)).size} people. ` +
    `SOS: ${n('sos')}, medical: ${n('medical')}, water/food: ${n('water')}, shelter: ${n('shelter')}.`;
  if (urgent.length) s += ' Latest urgent: ' + urgent.map(m => `${m.from}: "${m.text.slice(0, 60)}"`).join(' | ');
  return s;
}

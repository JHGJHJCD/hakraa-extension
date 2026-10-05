// הקראה — תוסף דפדפן. פותח את חלונית הצד ושולח אליה את הטקסט שסומן (או את כל הדף).
const MENU_SEL = "hakraa-sel", MENU_PAGE = "hakraa-page";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({id: MENU_SEL, title: "🔊 הקרא בקול", contexts: ["selection"]});
    chrome.contextMenus.create({id: MENU_PAGE, title: "🔊 הקרא את כל הדף", contexts: ["page"]});
  });
});

function selText(){ return String(getSelection()); }
function pageText(){
  const el = document.querySelector("article") || document.querySelector("main") || document.body;
  return el.innerText;
}

// הטקסט נלקח מהדף עצמו (שומר על ירידות שורה); בדפים שאי אפשר לגעת בהם — מה שהדפדפן מסר
async function grab(tab, frameId, whole){
  try {
    const [r] = await chrome.scripting.executeScript({
      target: {tabId: tab.id, frameIds: [frameId || 0]}, func: whole ? pageText : selText});
    return (r && r.result) || "";
  } catch (e) { return ""; }
}
async function send(text, win){
  if (text && text.trim()) await chrome.storage.session.set({pending: {text, t: Date.now(), win}});
}

// sidePanel.open חייב להיקרא מיד בתוך הלחיצה, לפני כל await
chrome.contextMenus.onClicked.addListener((info, tab) => {
  // לחיצה בתוך החלונית עצמה (או בדף בלי לשונית) — אין לשונית; מקריאים את מה שהדפדפן מסר
  if (!tab || tab.windowId == null) { send(info.selectionText || "", null); return; }
  chrome.sidePanel.open({windowId: tab.windowId}).catch(() => {});
  grab(tab, info.frameId, info.menuItemId === MENU_PAGE).then(t => send(t || info.selectionText || "", tab.windowId));
});
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({windowId: tab.windowId}).catch(() => {});
  grab(tab, 0, false).then(t => send(t, tab.windowId));
});

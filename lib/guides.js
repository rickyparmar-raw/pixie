// Interactive step-by-step guides for common workflows.
//
// The original version advanced on *any* reply and matched its alternate paths
// with `response.includes("not enough RE")` — literal phrases nobody types, so
// every alternate branch was unreachable and "wait, what?" marched the user to
// the next step. Progression is now model-checked: the reply is classified as
// advancing, stuck (with which alternate), off-topic, or done.
const { config } = require("./config");
// Module object rather than a destructured `complete`, so tests can stub it —
// destructuring binds at load time. Same reason lib/learn.js holds it this way.
const llm = require("./llm");
// Module object rather than destructured — same stubbing reason as the note
// on lib/respond.js's `answer` import.
const answer = require("./answer");
const { looksLikeHelpRequest } = require("./intent");
const db = require("./db");
const log = require("./log");

const MAX_TOKENS = 20;
const TIMEOUT_MS = 10000;

// Real headroom for a real answer — an install command, a specific fix — not
// the 20-token classifier budget above.
const STUCK_ANSWER_MAX_TOKENS = 400;

const ADVANCE = "ADVANCE";
const STUCK = "STUCK";
const OTHER = "OTHER";
const DONE = "DONE";

// Typed anywhere in a guide thread, bails out immediately. Checked before the
// model call so quitting is always free and always works.
const EXIT_PATTERN = /^\s*(?:stop|quit|exit|cancel|nvm|nevermind|never mind|forget it|no thanks|nah im good|nah i'm good)\b/i;

const GUIDES = {
  "next-region": {
    name: "How to unlock the next region",
    steps: [
      {
        message: "alright so to unlock a new region you gotta complete sidequests and earn restoration energy (RE) :yay:",
        checkNext: "Check your current RE on the game dashboard at https://pixl.hackclub.com/ — how much RE do you have rn?",
      },
      {
        message: "nice! each region needs a certain amount of RE to unlock. the game shows you the requirement when you try to enter a locked region.",
        checkNext: "Have you finished all the sidequests in your current region? (yes/no)",
      },
      {
        message: "cool — once you finish all sidequests in a region and have enough RE, the next region auto-unlocks. just head to the map and click the newly available region :3c:",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "not enough restoration energy": "you need more restoration energy! ship more projects to earn RE — each approved sidequest gives you RE based on the time you spent building it",
      "stuck on a specific sidequest": "which sidequest are you stuck on? i can help with specific questions or you can ask a helper in this channel :hii:",
    },
  },

  "git-setup": {
    name: "Setting up Git and GitHub",
    steps: [
      {
        message: "let's get git set up! first, do you have git installed? try running `git --version` in your terminal",
        checkNext: "Does it show a version number or say command not found?",
      },
      {
        message: 'great! now let\'s configure it with your info. run these two commands:\n```\ngit config --global user.name "Your Name"\ngit config --global user.email "your@email.com"\n```\nUse the same email as your GitHub account so commits link to your profile.',
        checkNext: "Done? (yes/no)",
      },
      {
        message: "awesome! now create a new repo on GitHub, then it'll show you commands like:\n```\ngit remote add origin https://github.com/yourusername/yourproject.git\ngit branch -M main\ngit push -u origin main\n```\nRun those in your project folder to push your code up :yesyes:",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "git is not installed / command not found": "you need to install git first! check out https://pixl.hackclub.com/docs#git for install instructions for your OS",
      "permission denied or SSH key error": "looks like an ssh key issue — easiest fix is to use HTTPS instead of SSH when GitHub gives you the remote URL",
    },
  },

  hackatime: {
    name: "Setting up Hackatime for time tracking",
    steps: [
      {
        message: "hackatime tracks your coding time automatically! first, what editor/IDE are you using? (VS Code, Cursor, Zed, something else?)",
        checkNext: null,
      },
      {
        message: "perfect! for VS Code/Cursor, install the WakaTime extension, then plug in your Hackatime API key and URL from your account. save some code and check the dashboard after a few minutes to make sure it's logging :3c:",
        checkNext: "Is it showing up on your Hackatime dashboard? (yes/no)",
      },
      {
        message: "nice! keep working and it'll track automatically. each project folder = one project, so keep different projects in separate folders if you're juggling multiple :yay:",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "time is not being tracked": "try these: 1) make sure you saved your files after editing, 2) check the WakaTime extension status in the bottom bar, 3) verify your API key and URL are correct in settings",
      "time is logged under the wrong project": "hackatime groups by folder name — rename your project folder or check the dashboard settings to merge/split projects",
    },
  },

  "shop-purchase": {
    name: "How to Buy Items from the Shop",
    steps: [
      {
      message: "alright so first u gotta open the shop tab at the bottom of the game :yay:",
        checkNext: "see the shop tab? (yes/no)",
        screenshot: "shop-purchase/01.webp",
      },
      {
        message: "nice! now just scroll through and click on whatever item u want",
        checkNext: "found something u like? (yes/no)",
        screenshot: "shop-purchase/02.webp",
      },
      {
    message: "sick choice! now hit the buy button if u have enough pixels",
        checkNext: "did the purchase go through? (yes/no)",
        screenshot: "shop-purchase/03.webp",
      },
      {
        message: "yay! check ur inventory to see ur new item :yesyes:",
        checkNext: null,
   screenshot: "shop-purchase/04.webp",
      },
    ],
    alternateSteps: {
      "not enough pixels": "oof u need more pixels! earn them by doing sidequests and playing the game — the more u do the more u get :3c:",
      "can't find shop": "the shop tab is at the bottom of the game screen, next to ur character avatar. should be hard to miss!",
    },
  },

  "customize-character": {
    name: "How to Customize Your Character",
    steps: [
{
        message: "ok so to customize ur character, open the character menu in the game :3c:",
    checkNext: "found the character menu? (yes/no)",
     screenshot: "customize-character/01.webp",
      },
      {
     message: "nice! now u can pick different options for ur character — skin tone, hair, clothes, accessories, etc. just click on what u wanna change",
        checkNext: "see all the customization options? (yes/no)",
   screenshot: "customize-character/02.webp",
      },
    {
        message: "perfect! once u're happy with how ur character looks, hit the save button to keep ur changes :yesyes:",
        checkNext: null,
        screenshot: "customize-character/03.webp",
      },
    ],
    alternateSteps: {
    "can't find character menu": "the character menu should be accessible from the main game screen — look for a button with ur avatar or a character icon",
      "changes not saving": "make sure u hit the save button before closing the menu! if it's still not working, try refreshing the game",
    },
  },

  "create-hackpad": {
    name: "How to Build Your Own Hackpad (Macropad)",
    steps: [
      {
        message: "yooo let's build u a macropad! :yay: (this walkthrough's adapted from Hack Club's hackpad program, hackpad.hackclub.com — full credit to them for the original guide) this is a whole project — PCB design, then a case, then firmware — but we'll go through it one step at a time. first, grab the KiCad care package from the hackpad resources page (https://hackpad.hackclub.com/resources), unzip `kicad_care_package.zip`, and install the `.sym`/`.pretty` libraries into KiCad (search youtube if u get stuck on the install itself)",
        checkNext: "got the library installed in KiCad? (yes/no)",
        screenshot: "create-hackpad/01.webp",
      },
      {
        message: 'nice! now open KiCad, make a new project, and click the "Schematic Editor" button',
        checkNext: "schematic editor open? (yes/no)",
        screenshot: "create-hackpad/02.webp",
      },
      {
        message: "in the schematic editor, press A to open the add-component menu. search for and add: MODULE-SEEEDUINO-XIAO (that's the microcontroller) and SW_Push (the switch — add 3 of those, one per key)",
        checkNext: "got the XIAO and all 3 switches placed? (yes/no)",
        screenshot: "create-hackpad/03.webp",
      },
      {
        message: "now wire it up — press W to start a wire, and connect ur 3 switches to pins 11, 10, and 9 on the microcontroller. press P and search GND to grab a ground symbol for the other side of each switch",
        checkNext: "all wired up? (yes/no)",
        screenshot: "create-hackpad/04.webp",
      },
      {
        message: 'time to assign footprints (what actually gets drawn on the PCB) — click the "run footprint assignment tool" button in the top right',
        checkNext: "footprint assignment window open? (yes/no)",
        screenshot: "create-hackpad/05.webp",
      },
      {
        message: "assign each component the matching footprint (match the reference image), then hit apply and save the schematic — schematic's officially done! :yesyes:",
        checkNext: "footprints assigned and schematic saved? (yes/no)",
        screenshot: "create-hackpad/06.webp",
      },
      {
        message: 'head back to the KiCad project page and open the "PCB Editor", then hit "Update PCB from Schematic" in the top right to pull ur components in',
        checkNext: "components dumped onto the PCB view? (yes/no)",
        screenshot: "create-hackpad/07.webp",
      },
      {
        message: "right click the XIAO and hit \"flip side\" (this puts it on the bottom for soldering), then arrange all the components to match the layout",
        checkNext: "components flipped and arranged? (yes/no)",
        screenshot: "create-hackpad/08.webp",
      },
      {
        message: "now route it! press X and click any gold pad with a blue line — it'll dim the screen and show u where to go. route every connection (switch layer from F.Cu to B.Cu on the right to see the blue lines)",
        checkNext: "PCB fully routed? (yes/no)",
        screenshot: "create-hackpad/09.webp",
      },
      {
        message: "last PCB step — switch to the Edge.Cuts layer and draw a rectangle outlining ur board size (use the measure tool to check the dimensions). that's the PCB done!! onto the case :3c:",
        checkNext: "board outline drawn on Edge.Cuts? (yes/no)",
        screenshot: "create-hackpad/10.webp",
      },
      {
        message: "case time, in Fusion360 (free personal license). new sketch, draw a rectangle matching ur PCB's dimensions plus 0.4mm on each side for printing tolerance",
        checkNext: "PCB-sized sketch drawn? (yes/no)",
        screenshot: "create-hackpad/11.webp",
      },
      {
        message: "now draw a bigger rectangle around that one with a 10mm margin — this'll be the outer wall of the case",
        checkNext: "margin rectangle drawn? (yes/no)",
        screenshot: "create-hackpad/12.webp",
      },
      {
        message: "sketch in the mounting holes too (u'll use these to screw the case together later)",
        checkNext: "mounting holes sketched? (yes/no)",
        screenshot: "create-hackpad/13.webp",
      },
      {
        message: "extrude the base of the case by 3mm",
        checkNext: "base extruded? (yes/no)",
        screenshot: "create-hackpad/14.webp",
      },
      {
        message: "now extrude the outer walls by 10mm (13mm tall total) — that's the bottom half of the case done",
        checkNext: "walls extruded? (yes/no)",
        screenshot: "create-hackpad/15.webp",
      },
      {
        message: 'onto the plate — head to ai03\'s plate generator (https://kbplate.ai03.com/) and paste in `["","",""],` to generate a 3-key plate. download the DXF and import it into Fusion360, making sure it\'s centered',
        checkNext: "plate imported and centered? (yes/no)",
        screenshot: "create-hackpad/16.webp",
      },
      {
        message: "extrude the plate by 3mm",
        checkNext: "plate extruded? (yes/no)",
        screenshot: "create-hackpad/17.webp",
      },
      {
        message: "last case step — add a USB cutout so u can actually plug the thing in. congrats, case is done!! :yay:",
        checkNext: "USB cutout added? (yes/no)",
        screenshot: "create-hackpad/18.webp",
      },
      {
        message: "final stretch — firmware. this uses QMK (https://qmk.fm/) — check out the porting guide at https://docs.qmk.fm/porting_your_keyboard_to_qmk to get ur specific board flashed. once that's working u've got a fully working macropad from scratch :yesyes: don't forget to ship it as a project on Pixl (https://pixl.hackclub.com/projects/) when u're done!",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "stuck on a specific step and googling didn't help": "no worries — most of this you can google in like 2 seconds, but if you're properly stuck just drop what you're stuck on in #hackpad and someone'll help u out :hii:",
      "doesn't have kicad or fusion360 installed": "kicad's free! on linux: `sudo apt install kicad` (debian/ubuntu), `sudo dnf install kicad` (fedora), `sudo pacman -S kicad` (arch), or `flatpak install flathub org.kicad.KiCad` if ur distro's repo version is old/outdated. everywhere else just grab the installer from https://www.kicad.org/. fusion360 has a free personal-use license at https://www.autodesk.com/products/fusion-360/personal (that's what this guide uses — u can sub in other CAD software but it'll be harder to follow along)",
      "doesn't know where to get the physical parts": "check the approved parts list at https://hackpad.hackclub.com/parts — hack club covers the parts for free if u're a teenager building along with this",
      "wants to add more keys, a knob, leds, etc": "totally doable! check https://hackpad.hackclub.com/add-components for how to wire up extra stuff like that — for a full submission u'll wanna customize it beyond the 3-key example anyway",
      "ready to submit the finished macropad": "hell yeah — head to https://pixl.hackclub.com/projects/ and ship it as a project, same as any other build",
      "pcb has drc errors or red marks after routing": "those red marks mean the DRC (design rule checker) caught something — usually two traces sitting too close together or a net that's not fully connected yet. run Inspect > Design Rules Checker to see the exact list, click each violation to jump straight to it, and re-route or nudge just that spot. if it's a clearance issue, widen the gap slightly or shrink the trace width a touch in its properties",
      "fusion360 asks to sign in or activate a personal use license": "yeah fusion360 makes u create a free autodesk account and pick the 'personal use' license the first time u open it — couple clicks on their site, no payment info needed. if it says ur trial expired instead, go back through account settings and make sure personal use is actually selected, not the 30-day trial",
      "plate generator output doesn't match the pcb, wrong size or key count": "double check the array u pasted into ai03's plate generator matches ur actual switch count and layout — each empty `\"\"` in the array is one key. also make sure it didn't get scaled on import into fusion360 — right click the imported sketch, check its dimensions, and rescale if it's off before extruding",
    },
  },

  "create-devboard": {
    name: "How to Design & Order Your Own Custom Devboard (PCB)",
    steps: [
      {
        message: "yooo let's design u a custom PCB devboard! :yay: (this walkthrough's adapted from Hack Club's OnBoard program, github.com/hackclub/OnBoard — full credit to them for the original guide) we'll go through designing it, then ordering the actual physical board",
        checkNext: "ready to get started? (yes/no)",
      },
      {
        message: "design rules to keep in mind the whole way through:\n• 2 or 4-layer FR-4 board\n• keep the default 1.6mm thickness (anything else forces the pricier Standard PCBA)\n• 0.3mm traces for signals / 0.5mm for power\n• 0.7mm vias with a 0.3mm hole\n\nopen up KiCad (recommended, free) or EasyEDA (web-based, no install) and start a new project",
        checkNext: "got your PCB software open and a new project started? (yes/no)",
      },
      {
        message: "place your microcontroller, USB-C connector, 3.3V LDO regulator and decoupling caps in the schematic editor and wire it all up, then switch to the PCB layout editor — draw a ground plane and route every trace",
        checkNext: "schematic wired and PCB routed? (yes/no)",
      },
      {
        message: "run DRC (Design Rule Check) until it comes back clean — zero errors — then export your fab files: gerber.zip, bom.csv, position/CPL csv, and a PDF of your schematic",
        checkNext: "DRC clean and gerber.zip + schematic.pdf exported? (yes/no)",
      },
      {
        message: "head to JLCPCB.com and upload your gerber.zip:\n• base material FR-4\n• layers auto-detect from the gerbers\n• bump PCB qty to 5 (the grant covers that many)",
        checkNext: "base options set? (yes/no)",
        screenshot: "create-devboard/02.webp",
      },
      {
        message: "next, PCB specifications:\n• leave thickness at 1.6mm (don't touch this one, it's what keeps u on Economic pricing)\n• pick whatever color u want (green/blue/black are cheapest)\n• HASL or ENIG for surface finish",
        checkNext: "specs set? (yes/no)",
        screenshot: "create-devboard/03.webp",
      },
      {
        message: "now assembly:\n• set PCBA type to Economic (Standard is way pricier)\n• choose 2 of your 5 boards for component assembly so the grant covers it",
        checkNext: "assembly set to Economic? (yes/no)",
        screenshot: "create-devboard/04.webp",
      },
      {
        message: "upload your BOM — bom.csv + positions.csv from KiCad (or BOM_PCB.csv + PickAndPlace.csv from EasyEDA)",
        checkNext: "BOM uploaded? (yes/no)",
        screenshot: "create-devboard/05.webp",
      },
      {
        message: "double check every part's orientation matches the preview JLCPCB shows u — eyeball each one before moving on, a flipped part is a dead board",
        checkNext: "orientation looking right? (yes/no)",
        screenshot: "create-devboard/06.webp",
      },
      {
        message: "stencil is optional and adds cost — leave it on 'No' unless u specifically want one for hand assembly",
        checkNext: "stencil setting sorted? (yes/no)",
        screenshot: "create-devboard/07.webp",
      },
      {
        message: "get to checkout, enter your shipping address, and BEFORE paying — screenshot the cart showing your total cost and save it as cart.png. u need this exact file for the PR later",
        checkNext: "got your cart.png? (yes/no)",
        screenshot: "create-devboard/08.webp",
      },
      {
        message: "pay directly — it's the recommended option, and u get refunded if your files don't pass review — then hit submit order",
        checkNext: "order submitted? (yes/no)",
        screenshot: "create-devboard/09.webp",
      },
      {
        message: "that's it!! your board's ordered and on its way from JLCPCB :yesyes: once it arrives, solder it up and u've got yourself a real working custom PCB — nice work. once it's built, ship it as a project on Pixl (https://pixl.hackclub.com/projects/) so it counts here too",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "doesn't have kicad or easyeda installed": "kicad's free and open-source — grab it from https://www.kicad.org/. easyeda's web-based (https://easyeda.com/) so there's nothing to install at all, just make an account and start a project",
      "pcb has drc errors": "same deal as any DRC error — usually two traces sitting too close together, or a net that isn't fully connected yet. run the design rule checker, click each violation to jump straight to it, and either widen the clearance or re-route that one spot",
      "not sure what layer count or thickness to pick": "2-layer is simplest and cheapest for a first board — go 4-layer only if you actually need the extra routing room. thickness should always stay at the default 1.6mm, changing it forces the pricier Standard PCBA option",
      "jlcpcb assembly or bom upload error": "make sure Economic PCBA is actually selected (not Standard), and that your BOM csv headers match what JLCPCB expects — LCSC Part #, Quantity, Designator. a mismatched header name is the most common reason the upload silently fails to map parts",
    },
  },

  "submit-ysws-guidelines": {
    name: "YSWS Project Submission Guidelines & Quality Rules",
    steps: [
      {
        message: "yooo let's get your YSWS project ready to submit! :yay: first, is your code on a public GitHub repo?",
        checkNext: "got your public repo link? (yes/no)",
        screenshot: null,
      },
      {
        message: "sweet! does the repo have a README and multiple commits showing your progress? (single-commit repos for high-hour projects get deflated/rejected!)",
        checkNext: "does it have multiple commits? (yes/no)",
        screenshot: null,
      },
      {
        message: "nice! now we need a playable URL. this must be a public link where anyone can run/play it (Vercel, itch.io, Netlify, direct binary download). raw code zips or google colab/jupyter notebooks are NOT allowed",
        checkNext: "got a playable URL? (yes/no)",
        screenshot: null,
      },
      {
        message: "awesome! for your hour count: time spent on art/assets (sprites, 3D models) is capped at 25% max of the total hours. also, AI code is allowed but simple 'AI slop' (single-prompt output with no edit/debugging) is banned.",
        checkNext: "do your hours match these rules? (yes/no)",
        screenshot: null,
      },
      {
        message: "lastly, make sure you take a screenshot of your app (.png/.webp, no GIFs!) and get your Hackatime dashboard URL ready as justification for your hours",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "what if i built a hardware project": "for hardware, your repo must include a Bill of Materials (BOM) with specific parts, PCB schematics/project files, 3D models in .STEP format (not just .STL), and firmware code!",
      "my project is a library or CLI": "libraries and CLIs must be published to a package manager (npm, PyPI, crates.io) with complete API usage docs so others can use them easily!",
      "can i submit team/duplicate projects": "yes, but you must fill out the 'Override Duplicate Justification' field and explain who worked on what so hours aren't double-counted.",
    },
  },
};

// Guide selection used to be `q.includes("hackatime")`, which meant one typo
// killed it: the live gap log has "pixie help me setup hackatimm" recorded as a
// docs miss, and `active_guides` had never held a row. Detection is now two
// passes — a free fuzzy one that catches the typo, then the model for phrasings
// no keyword list would predict.
//
// `subject` groups are synonyms and every group must match; `hints` say the
// person wants to be walked through it rather than just mentioning the word.
//
// The subject list does double duty: mentionsGuideSubject uses it alone to
// decide whether the model pass is worth a call at all, so a synonym missing
// here means that guide is unreachable for anyone who doesn't name it. Hence
// "hours" — "how do i make my coding hours count" is a hackatime question that
// never says hackatime.
const GUIDE_TRIGGERS = [
  ["next-region", { subject: [["region", "regions"]], hints: ["unlock", "next", "new", "open"] }],
  [
    "git-setup",
    { subject: [["git", "github"]], hints: ["setup", "set", "install", "configure", "config", "start", "push"] },
  ],
  [
    "hackatime",
    {
      subject: [["hackatime", "wakatime", "hours"]],
      hints: ["setup", "set", "install", "track", "tracking", "time", "log"],
    },
  ],
  [
    "shop-purchase",
    {
      // "pixels" used to be in here — "how do i get pixels" (an economy/
      // earning question, nothing to do with the shop) matched shop-purchase
      // every time, because "pixels" is the currency's name, not a shop-
      // specific word. "shop"/"store"/"item" already cover every real way
      // someone asks about buying something.
      subject: [["shop", "store", "buy", "purchase", "item"]],
      hints: ["how", "buy", "purchase", "get", "unlock", "afford"],
    },
  ],
  [
    "submit-ysws-guidelines",
    {
      subject: [["ysws", "submission", "guidelines", "rules", "qualify", "requirements"]],
      hints: ["submit", "rule", "shipped", "hours", "deflate", "reject", "guideline", "how"],
    },
  ],
  [
    "customize-character",
    {
    subject: [["character", "avatar", "appearance", "skin", "customize"]],
      // Same reasoning as submit-project above — "how" + "character" (e.g.
      // "how does my character level up") isn't a customization question.
      hints: ["customize", "change", "edit", "personalize"],
    },
  ],
  [
    "create-hackpad",
    {
      subject: [["hackpad", "macropad", "kicad"]],
      hints: ["build", "make", "create", "start", "how", "setup", "set"],
    },
  ],
  [
    "create-devboard",
    {
      subject: [["devboard", "pcb", "circuit", "onboard"]],
      hints: ["build", "make", "design", "order", "create", "how", "setup", "grant"],
    },
  ],
];

// Budget scales with length because a fixed one is wrong at both ends: 2 edits
// on a three-letter word turns "get" into "git", while 1 edit isn't enough slack
// for a word as long as "hackatime".
function editBudget(word) {
  if (word.length <= 4) return 0;
  if (word.length <= 7) return 1;
  return 2;
}

// Damerau-Levenshtein, not plain Levenshtein: a swapped pair of letters is the
// most common typo there is, and plain edit distance scores it 2, which puts
// "regoin" out of reach of a 1-edit budget for "region". Counting a transposition
// as one edit is what makes the budgets below tight enough to be safe and loose
// enough to be useful.
//
// Stops as soon as an entire row exceeds the budget — this runs per token per
// guide on every message, so the early exit matters more than the exact distance
// once we're past the threshold.
function withinEdits(a, b, budget) {
  if (Math.abs(a.length - b.length) > budget) return false;

  let prevPrev = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      row[j] = value;
      if (value < best) best = value;
    }
    if (best > budget) return false;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length] <= budget;
}

function matchesToken(tokens, word) {
  const budget = editBudget(word);
  return tokens.some((t) => (budget === 0 ? t === word : withinEdits(t, word, budget)));
}

// Splitting the question into words once, shared by every pass below.
function tokensOf(question) {
  return (question || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// The free pass. Returns a guide id or null; never makes a network call.
function detectGuideByKeyword(question) {
  const tokens = tokensOf(question);
  if (tokens.length === 0) return null;

  for (const [id, trigger] of GUIDE_TRIGGERS) {
    const hasSubject = trigger.subject.every((group) => group.some((word) => matchesToken(tokens, word)));
    if (hasSubject && trigger.hints.some((word) => matchesToken(tokens, word))) return id;
  }
  return null;
}

function guideChooserPrompt() {
  const catalogue = Object.entries(GUIDES)
    .map(([id, guide]) => `${id}: ${guide.name}`)
    .join("\n");

  return [
    "Pixie can walk someone through a few setup workflows step by step.",
    "",
    "Available walkthroughs:",
    catalogue,
    "",
    "Decide whether this person is asking to be walked through one of them.",
    "Reply with EXACTLY the id, or NONE.",
    "",
    "Pick a walkthrough only when they want to be taken through the process.",
    "Answer NONE for a one-off factual question about the same topic — those are better",
    "answered from the docs than by starting a multi-step walkthrough they didn't ask for.",
  ].join("\n");
}

// Second pass. Only reached when the keyword pass missed AND the message is
// already a help request, so ordinary chat never pays for it. Runs before the
// answer path rather than alongside it — a guide match replaces the answer call
// instead of adding to it.
async function detectGuideByModel(question) {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: guideChooserPrompt() },
          { role: "user", content: question },
        ],
      },
      "guides",
    );

    const label = (text || "").trim().toLowerCase();
    return Object.keys(GUIDES).find((id) => label.startsWith(id)) || null;
  } catch (e) {
    log.debug("guides", `guide selection failed: ${e.message}`);
    return null;
  }
}

// Is there any guide this message could possibly be about? Same fuzzy match as
// the keyword pass, but only on the SUBJECT groups — the hints are dropped, so
// merely naming git or hackatime is enough to qualify.
//
// This exists because the model pass ran on every help-shaped message the
// keyword pass missed, which is nearly all of them: ~1700ms of latency added in
// front of the answer call, to return NONE. A question that never mentions a
// region, git or hackatime — however badly typed — has no guide to choose.
function mentionsGuideSubject(question) {
  const tokens = tokensOf(question);
  if (tokens.length === 0) return false;
  return GUIDE_TRIGGERS.some(([, trigger]) =>
    trigger.subject.every((group) => group.some((word) => matchesToken(tokens, word))),
  );
}

// A keyword match only proves the words *could* be about some guide — not
// that the person actually wants to be walked through it, rather than just
// asking a question that happens to share vocabulary with the trigger list.
// ("how to get pixels" matching shop-purchase, "how does my character level
// up" matching customize-character, and a whole thread's worth of similar
// hijacks all shipped this way — see the individual trigger comments above.)
// Trimming the trigger lists fixes each specific phrase as it's found, but
// it's still a keyword guess; it can't tell "walk me through submitting a
// project" apart from "why did my project's submission get rejected". Every
// keyword hit — not just a keyword miss — now gets confirmed by the same
// model check used below, which is built to draw exactly that distinction
// (see guideChooserPrompt: "Pick a walkthrough only when they want to be
// taken through the process"). Only a message that mentions no guide subject
// at all skips the model call, since there's nothing for it to confirm.
async function detectGuideIntent(question) {
  const byKeyword = detectGuideByKeyword(question);
  if (!byKeyword) {
    if (!mentionsGuideSubject(question)) return null;
    if (!looksLikeHelpRequest(question)) return null;
  }
  return detectGuideByModel(question);
}

function isExitRequest(text) {
  return EXIT_PATTERN.test(text || "");
}

function stepPayload(step, guideName = null) {
  return {
    message: step.message,
    checkNext: step.checkNext || null,
    screenshot: step.screenshot || null,
    guideName,
  };
}

function startGuide(guideId, threadTs, userId) {
  const guide = GUIDES[guideId];
  if (!guide) return null;

  // A thread only has one guide slot (active_guides is keyed on thread_ts
  // alone). Without this check, a different person asking an unrelated
  // guide-shaped question in the same thread would silently steal that slot
  // mid-walkthrough — db.saveGuide's ON CONFLICT upsert would overwrite
  // whoever was already partway through. Decline instead; they get a normal
  // answer.
  const existing = db.getGuide(threadTs);
  if (existing && existing.user_id && userId && existing.user_id !== userId) return null;

  db.saveGuide(threadTs, guideId, 0, userId);
  return stepPayload(guide.steps[0], guide.name);
}

function isInGuide(threadTs) {
  return !!db.getGuide(threadTs);
}

function cancelGuide(threadTs) {
  db.deleteGuide(threadTs);
}

function classifierPrompt(guide, step, alternateKeys) {
  const alternates = alternateKeys.map((k, i) => `STUCK_${i + 1}: they hit this problem — ${k}`).join("\n");

  return [
    `A user is being walked through: "${guide.name}".`,
    `The step they were just given: "${step.message}"`,
    step.checkNext ? `They were asked: "${step.checkNext}"` : "",
    "",
    "Classify their reply as EXACTLY one of these labels, nothing else:",
    `${ADVANCE}: they did the step / answered it / are ready to move on`,
    alternates,
    `${OTHER}: they asked a different question, or said something unrelated to this step`,
    `${DONE}: they want to stop the walkthrough`,
    "",
    "Answer with just the label.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Classifies the user's reply against the current step. Falls back to ADVANCE
// on failure so an API outage can't strand someone mid-guide.
async function classifyStepReply(guide, step, alternateKeys, userResponse) {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: MAX_TOKENS,
        temperature: 0.2,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: classifierPrompt(guide, step, alternateKeys) },
          { role: "user", content: userResponse },
        ],
      },
      "guides",
    );

    const label = (text || "").trim().toUpperCase();
    if (label.startsWith(DONE)) return { kind: DONE };
    if (label.startsWith(OTHER)) return { kind: OTHER };
    if (label.startsWith("STUCK_")) {
      const index = Number(label.slice("STUCK_".length).match(/^\d+/)?.[0]) - 1;
      if (alternateKeys[index]) return { kind: STUCK, alternateKey: alternateKeys[index] };
    }
    return { kind: ADVANCE };
  } catch (e) {
    log.debug("guides", `step classification failed (${e.message}), advancing`);
    return { kind: ADVANCE };
  }
}

function stuckAnswerPrompt(guide, step, alternateKey, canned, inHelpChannel) {
  return [
    `A user is being walked through: "${guide.name}".`,
    `The exact step they're currently on: "${step.message}"`,
    `They've hit this general kind of problem: ${alternateKey}`,
    `Pixie's own fallback line for this (only worth using if you truly have nothing better): ${canned}`,
    "",
    "Give a REAL, specific, technical answer — using your own general knowledge of the tools involved (KiCad,",
    "Fusion360, PCB design, electronics, Linux/package managers, whatever's relevant), exactly like you would for",
    "any tech question. Even if their message is vague ('i'm struggling with this', 'this isn't working', 'stuck') —",
    "don't deflect to asking someone else. Think about what commonly goes wrong at THE EXACT STEP quoted above and",
    "give concrete troubleshooting for it: what to check, what the usual fix is — the way an experienced maker",
    "helping a friend over Discord would, not a support script pointing them elsewhere.",
    "Only mention #hackpad as a closing line if you genuinely can't offer anything useful even with the step's",
    "context — never make that the whole answer, and never make it the first thing you say.",
    ...answer.VOICE,
    "Keep it short — 1-3 sentences, unless real troubleshooting specifics genuinely need more room.",
    answer.pixlGuardrail(inHelpChannel),
  ].join("\n");
}

// A STUCK match used to reply with the exact same canned string every time,
// regardless of what was actually asked — "how do i get X" and "how do i get
// X on Linux using commands" got back the identical generic pointer. This
// gives the model the canned guidance as grounding and lets it actually
// answer what was asked, the same way pixie already does for any other
// general (non-Pixl-specific) question. Falls back to the canned text on any
// failure — an API hiccup should never leave someone stuck with nothing.
async function answerStuckQuestion(guide, step, alternateKey, userResponse, inHelpChannel = false) {
  const canned = guide.alternateSteps[alternateKey];
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.answer.baseUrl,
        apiKey: config.answer.apiKey,
        model: config.answer.model,
        fallback: config.answer.fallback,
        onRateLimited: config.answer.onRateLimited,
        maxTokens: STUCK_ANSWER_MAX_TOKENS,
        temperature: 0.3,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: stuckAnswerPrompt(guide, step, alternateKey, canned, inHelpChannel) },
          { role: "user", content: userResponse },
        ],
      },
      "guides",
    );

    const reply = (text || "").trim();
    return reply ? answer.normalizeEmoji(reply) : canned;
  } catch (e) {
    log.debug("guides", `stuck-answer generation failed (${e.message}), using canned reply`);
    return canned;
  }
}

// Shared by continueGuide's ADVANCE branch and advanceGuideByReaction — moves
// to the next step, or finishes the guide when there isn't one.
function advanceToNextStep(threadTs, state, guide) {
  const nextIndex = state.current_step + 1;
  if (nextIndex >= guide.steps.length) {
    db.deleteGuide(threadTs);
    return { message: "all set! lmk if you hit any issues :hii:", screenshot: null, completed: true };
  }

  db.saveGuide(threadTs, state.guide_id, nextIndex, state.user_id);
  return stepPayload(guide.steps[nextIndex]);
}

// A :upvote: reaction on a guide step's own message is an explicit,
// unambiguous "I'm ready for the next step" — no classifier call needed, and
// no yes/no question to answer. Scoped to the guide's owner the same way a
// typed reply is (see the user_id check in continueGuide) so someone else
// reacting on the thread can't advance a walkthrough that isn't theirs.
// Returns the same shape as continueGuide, or null when there's nothing to
// advance (guide already gone, or this isn't the person it was started for).
function advanceGuideByReaction(threadTs, userId) {
  const state = db.getGuide(threadTs);
  if (!state) return null;

  const guide = GUIDES[state.guide_id];
  if (!guide) {
    db.deleteGuide(threadTs);
    return null;
  }

  if (state.user_id && userId && state.user_id !== userId) return null;

  return advanceToNextStep(threadTs, state, guide);
}

// Returns a payload to post, or null when the caller should handle the message
// normally instead (off-topic question, or no active guide).
//
//   { message, checkNext }            -> next step / alternate advice
//   { message, completed: true }      -> guide finished
//   { message, cancelled: true }      -> user bailed out
//   null                              -> not a guide reply, answer it normally
async function continueGuide(threadTs, userResponse, userId = null, inHelpChannel = false) {
  const state = db.getGuide(threadTs);
  if (!state) return null;

  const guide = GUIDES[state.guide_id];
  if (!guide) {
    db.deleteGuide(threadTs);
    return null;
  }

  // Thread guide state has no idea who's talking — only the person it was
  // started for can advance or exit it. Without this, a bare "yea" meant for
  // someone else entirely in the same thread reads exactly like ADVANCE to
  // the step classifier, and the guide marches on for a person who never
  // replied to it at all. Anyone else's message just falls through to a
  // normal answer instead.
  if (state.user_id && userId && state.user_id !== userId) return null;

  if (isExitRequest(userResponse)) {
    db.deleteGuide(threadTs);
return { message: "no worries, stopping there — ping me if you wanna pick it back up :hii:", screenshot: null, cancelled: true };
  }

  const step = guide.steps[state.current_step];
  const alternateKeys = Object.keys(guide.alternateSteps || {});
  const verdict = await classifyStepReply(guide, step, alternateKeys, userResponse);

  if (verdict.kind === DONE) {
    db.deleteGuide(threadTs);
    return { message: "cool, stopping the walkthrough — lmk if you need anything else :hii:", cancelled: true };
  }

  // Off-topic: leave the guide parked and let the normal answer path handle it,
  // so a real question mid-guide still gets a real answer.
  if (verdict.kind === OTHER) return null;

  if (verdict.kind === STUCK) {
    const message = await answerStuckQuestion(guide, step, verdict.alternateKey, userResponse, inHelpChannel);
    return { message, checkNext: null, screenshot: null, isAlternate: true };
  }

  return advanceToNextStep(threadTs, state, guide);
}

// Shown once — see buildGuideBlocks below.
const GUIDE_REACTION_HINT = "react :upvote: on this message when you're ready for the next step — or just tell me if you're stuck";

// Builds Slack Block Kit blocks for a guide step. Always returns blocks, even
// with no screenshot — a plain-text step used to be one long paragraph with
// the question mashed onto the end of it, which read as a wall of text
// instead of a guide. Splitting the message and the question into their own
// section blocks (with the question bolded) gives Slack's renderer room to
// actually space them out.
//
// showReactionHint is only true on a guide's very first step: repeating the
// full "react :upvote:..." sentence at the end of EVERY step's text was the
// literal complaint — teach the mechanic once, in its own small context
// block, and never repeat it.
function buildGuideBlocks(result, baseUrl, { showReactionHint = false } = {}) {
  const blocks = [];

  if (result.screenshot) {
    blocks.push({
      type: "image",
      image_url: `${baseUrl}/screenshots/${result.screenshot}`,
      alt_text: "Guide step screenshot",
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: result.message },
  });

  if (result.checkNext) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${result.checkNext}*` },
    });
  }

  if (showReactionHint && result.checkNext) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: GUIDE_REACTION_HINT }],
    });
  }

  return blocks;
}

module.exports = {
  GUIDES,
  detectGuideIntent,
  detectGuideByKeyword,
  mentionsGuideSubject,
  guideChooserPrompt,
  startGuide,
  continueGuide,
  advanceGuideByReaction,
  isInGuide,
  cancelGuide,
  isExitRequest,
  classifierPrompt,
  stuckAnswerPrompt,
  answerStuckQuestion,
  buildGuideBlocks,
  GUIDE_REACTION_HINT,
  ADVANCE,
  STUCK,
  OTHER,
  DONE,
};

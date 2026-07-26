// Interactive step-by-step guides for common workflows
const { getGroundedAnswer } = require("./answer");
const knowledge = require("./knowledge");

// Guide definitions - each guide is a series of steps
const GUIDES = {
  "next-region": {
    name: "How to unlock the next region",
    steps: [
      {
        message: "alright so to unlock a new region you gotta complete sidequests and earn restoration energy (RE) :yay:",
        checkNext: () => "Check your current RE on the game dashboard at https://play.pixl.rsvp/ — how much RE do you have rn?"
      },
      {
        message: "nice! each region needs a certain amount of RE to unlock. the game shows you the requirement when you try to enter a locked region.",
        checkNext: () => "Have you finished all the sidequests in your current region? (yes/no)"
      },
      {
        message: "cool — once you finish all sidequests in a region and have enough RE, the next region auto-unlocks. just head to the map and click the newly available region :3c",
        checkNext: null // end of guide
      }
    ],
    alternateSteps: {
      "not enough RE": "you need more restoration energy! ship more projects to earn RE — each approved sidequest gives you RE based on the time you spent building it",
      "stuck on a sidequest": "which sidequest are you stuck on? i can help with specific questions or you can ask a helper in this channel :hii:",
    }
  },
  
  "git-setup": {
    name: "Setting up Git and GitHub",
    steps: [
      {
        message: "let's get git set up! first, do you have git installed? try running `git --version` in your terminal",
        checkNext: () => "Does it show a version number or say command not found?"
      },
      {
        message: "great! now let's configure it with your info. run these two commands:\n```\ngit config --global user.name \"Your Name\"\ngit config --global user.email \"your@email.com\"\n```\nUse the same email as your GitHub account so commits link to your profile.",
        checkNext: () => "Done? (yes/no)"
      },
      {
        message: "awesome! now create a new repo on GitHub, then it'll show you commands like:\n```\ngit remote add origin https://github.com/yourusername/yourproject.git\ngit branch -M main\ngit push -u origin main\n```\nRun those in your project folder to push your code up :yesyes:",
        checkNext: null
      }
    ],
    alternateSteps: {
      "command not found": "you need to install git first! check out https://www.pixl.rsvp/docs#git for install instructions for your OS",
      "permission denied": "looks like a ssh key issue — easiest fix is to use HTTPS instead of SSH when GitHub gives you the remote URL",
    }
  },

  "hackatime": {
    name: "Setting up Hackatime for time tracking",
    steps: [
      {
        message: "hackatime tracks your coding time automatically! first, what editor/IDE are you using? (VS Code, Cursor, Zed, something else?)",
        checkNext: (answer) => answer.toLowerCase()
      },
      {
        message: "perfect! for VS Code/Cursor, install the WakaTime extension, then plug in your Hackatime API key and URL from your account. save some code and check the dashboard after a few minutes to make sure it's logging :3c",
        checkNext: () => "Is it showing up on your Hackatime dashboard? (yes/no)"
      },
      {
        message: "nice! keep working and it'll track automatically. each project folder = one project, so keep different projects in separate folders if you're juggling multiple :yay:",
        checkNext: null
      }
    ],
    alternateSteps: {
      "not tracking": "try these: 1) make sure you saved your files after editing, 2) check the WakaTime extension status in the bottom bar, 3) verify your API key and URL are correct in settings",
      "wrong project": "hackatime groups by folder name — rename your project folder or check the dashboard settings to merge/split projects",
    }
  }
};

// Guide state tracking - threadTs -> { guideId, currentStep, history }
const activeGuides = new Map();
const GUIDE_TTL = 30 * 60 * 1000; // 30 minutes

function detectGuideIntent(question) {
  const q = question.toLowerCase();
  
  if (q.includes("next region") || q.includes("unlock") && q.includes("region")) {
    return "next-region";
  }
  if (q.includes("git setup") || q.includes("github setup") || q.includes("set up git")) {
    return "git-setup";
  }
  if (q.includes("hackatime") && (q.includes("setup") || q.includes("set up") || q.includes("track"))) {
    return "hackatime";
  }
  
  return null;
}

function startGuide(guideId, threadTs, userId) {
  if (!GUIDES[guideId]) return null;
  
  activeGuides.set(threadTs, {
    guideId,
    currentStep: 0,
    userId,
    startedAt: Date.now(),
    history: []
  });
  
  const guide = GUIDES[guideId];
  const firstStep = guide.steps[0];
  
  return {
    message: firstStep.message,
    checkNext: firstStep.checkNext ? firstStep.checkNext() : null,
    guideName: guide.name
  };
}

function continueGuide(threadTs, userResponse) {
  const state = activeGuides.get(threadTs);
  if (!state) return null;
  
  // Check if guide is stale
  if (Date.now() - state.startedAt > GUIDE_TTL) {
    activeGuides.delete(threadTs);
    return null;
  }
  
  const guide = GUIDES[state.guideId];
  state.history.push(userResponse);
  
  // Check for alternate paths
  const response = userResponse.toLowerCase();
  for (const [trigger, altMessage] of Object.entries(guide.alternateSteps || {})) {
    if (response.includes(trigger.toLowerCase())) {
      return { message: altMessage, checkNext: null, isAlternate: true };
    }
  }
  
  // Move to next step
  state.currentStep++;
  
  if (state.currentStep >= guide.steps.length) {
    activeGuides.delete(threadTs);
    return { message: "all set! lmk if you hit any issues :hii:", checkNext: null, completed: true };
  }
  
  const nextStep = guide.steps[state.currentStep];
  return {
    message: nextStep.message,
    checkNext: nextStep.checkNext ? nextStep.checkNext(userResponse) : null
  };
}

function isInGuide(threadTs) {
  return activeGuides.has(threadTs);
}

function cancelGuide(threadTs) {
  activeGuides.delete(threadTs);
}

// Cleanup stale guides
setInterval(() => {
  const now = Date.now();
  for (const [threadTs, state] of activeGuides) {
    if (now - state.startedAt > GUIDE_TTL) {
      activeGuides.delete(threadTs);
    }
  }
}, 10 * 60 * 1000);

module.exports = {
  GUIDES,
  detectGuideIntent,
  startGuide,
  continueGuide,
  isInGuide,
  cancelGuide
};

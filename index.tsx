/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import { marked } from 'marked';

const GEMINI_API_KEY = process.env.API_KEY;

const BOOK_TITLE_BASE = "The O'Callaghan Stratagem"; // Thematic title
const NUM_CHOICES_TO_GENERATE = 3; // How many choices AI should offer
const PROTAGONIST_NAME = "James Burvell O'Callaghan III";
const PRIMARY_ENTITY = "Citibank Demo Business Inc.";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- UI Elements ---
let appContainer: HTMLElement;
let controlsPanel: HTMLElement;
let storyDisplayPanel: HTMLElement;
let storyContentElement: HTMLElement;
let choicesArea: HTMLElement;
let choicesLabel: HTMLElement;
let actionButton: HTMLButtonElement;
let downloadStoryButton: HTMLButtonElement;
let statusArea: HTMLElement;
let bookTitleDisplay: HTMLElement;

// Chat UI Elements
let chatModule: HTMLElement;
let chatToggle: HTMLButtonElement;
let chatToggleIcon: HTMLElement;
let chatPanelContent: HTMLElement;
let chatHistoryDisplay: HTMLElement;
let chatInput: HTMLTextAreaElement;
let chatSendButton: HTMLButtonElement;


// --- State Variables ---
type StorySectionType = 'prologue' | 'chapter';
type StorySection = {
  type: StorySectionType;
  title: string;
  htmlContent: string; // This will store the <section>...</section> HTML block
  chosenPath: string; // The choice that LED to this section
  rawTextContent?: string; // Store raw text for narration generation
  sectionTitleForNarration?: string; // Store H2 title for narration
};

let currentStory: StorySection[] = [];
let currentSectionType: StorySectionType | 'ended' = 'prologue';
let currentChapterNumber = 0;
let storyContext: string[] = []; // Now stores full text history
let isGenerating = false;

let ttsSupported = false;
let currentSpeechUtterance: SpeechSynthesisUtterance | null = null;
let currentlySpeakingSectionElement: HTMLElement | null = null;

let isGeneratingVideoScript = false;
let currentVideoNarrationUtterance: SpeechSynthesisUtterance | null = null;
let currentlyVideoNarratingSectionElement: HTMLElement | null = null;

// Chat State Variables
type ChatMessage = {
    sender: 'user' | 'ai' | 'system';
    text: string; // Raw text
    htmlText?: string; // Parsed HTML for AI messages
};
let chatMessages: ChatMessage[] = [];
let isChatExpanded = false;
let isGeneratingChatResponse = false;


// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  appContainer = document.getElementById('app-container')!;
  controlsPanel = document.getElementById('controls-panel')!;
  storyDisplayPanel = document.getElementById('story-display-panel')!;
  storyContentElement = document.getElementById('story-content')!;
  choicesArea = document.getElementById('choices-area')!;
  choicesLabel = document.getElementById('choices-label')!;
  actionButton = document.getElementById('action-button') as HTMLButtonElement;
  downloadStoryButton = document.getElementById('download-story-button') as HTMLButtonElement;
  statusArea = document.getElementById('status-area')!;
  bookTitleDisplay = document.getElementById('book-title-display')!;

  // Chat UI Elements
  chatModule = document.getElementById('chat-module')!;
  chatToggle = document.getElementById('chat-toggle') as HTMLButtonElement;
  chatToggleIcon = chatToggle.querySelector('.chat-toggle-icon')!;
  chatPanelContent = document.getElementById('chat-panel-content')!;
  chatHistoryDisplay = document.getElementById('chat-history')!;
  chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
  chatSendButton = document.getElementById('chat-send-button') as HTMLButtonElement;


  if (!GEMINI_API_KEY) {
    updateStatus("🔴 **FATAL ERROR:** API_KEY is not set. The application cannot connect to the AI. Please ensure the API_KEY environment variable is correctly configured.", true);
    if (actionButton) {
        actionButton.textContent = "API KEY MISSING";
        actionButton.disabled = true;
    }
    if (downloadStoryButton) downloadStoryButton.disabled = true;
    if (chatInput) chatInput.disabled = true;
    if (chatSendButton) chatSendButton.disabled = true;
    if (chatToggle) chatToggle.disabled = true;

    const choicesLabelElement = document.getElementById('choices-label');
    if (choicesLabelElement) choicesLabelElement.textContent = "Application disabled due to missing API key.";
    return;
  }
  
  bookTitleDisplay.textContent = BOOK_TITLE_BASE;
  actionButton.onclick = handleActionButtonClick;
  downloadStoryButton.onclick = handleDownloadStoryClick;

  // Chat Event Listeners
  chatToggle.onclick = handleChatToggleClick;
  chatSendButton.onclick = handleSendChatMessage;
  chatInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSendChatMessage();
    }
  });


  ttsSupported = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  if (!ttsSupported) {
    updateStatus("ℹ️ Text-to-speech is not supported by your browser. The 'Read Aloud' and 'Video Narration' features will be unavailable.", false);
  }
  (window as any).handleReadAloud = handleReadAloud; 
  (window as any).handleVideoNarration = handleVideoNarration;


  updateButtonAndChoiceUI();
  updateStatus(` attuned to the whispers of high finance. Click 'Start New Stratagem' to begin guiding ${PROTAGONIST_NAME}.`);
  renderChatMessages(); // Initial render (empty or with a welcome message)
});

// --- Core Logic ---

function stopAllSpeech() {
  if (ttsSupported && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
  }

  if (currentSpeechUtterance && currentlySpeakingSectionElement) {
    const oldButton = currentlySpeakingSectionElement.querySelector<HTMLButtonElement>('.read-aloud-button');
    if (oldButton) {
        oldButton.textContent = '🔊 Read Aloud';
        oldButton.setAttribute('aria-label', 'Read section content aloud');
    }
  }
  currentSpeechUtterance = null;
  currentlySpeakingSectionElement = null;

  if (currentVideoNarrationUtterance && currentlyVideoNarratingSectionElement) {
    const oldVideoButton = currentlyVideoNarratingSectionElement.querySelector<HTMLButtonElement>('.video-narrate-button');
    if (oldVideoButton) {
        oldVideoButton.textContent = '🎬 Create Video Narration';
        oldVideoButton.setAttribute('aria-label', 'Create AI-generated video narration for this section');
    }
  }
  currentVideoNarrationUtterance = null;
  currentlyVideoNarratingSectionElement = null;
}


async function updateStatus(message: string, isError: boolean = false) {
  try {
    statusArea.innerHTML = await marked.parse(message); 
  } catch (e) {
    console.error("Error rendering status message with marked:", e);
    statusArea.textContent = message; 
  }
  statusArea.className = isError ? 'status-error' : 'status-info';
  if (isError) {
    console.error("Status Update (Error):", message);
  } else {
    console.log("Status Update:", message);
  }
}

async function handleActionButtonClick() {
  if (isGenerating && currentStory.length > 0) return; 
  stopAllSpeech();
  await startNewStory();
}

async function startNewStory() {
  if (isGenerating) { 
      updateStatus("🔄 Restarting stratagem... Previous machinations unravel.", false);
  }
  isGenerating = true; 
  stopAllSpeech();

  currentStory = [];
  storyContext = []; // Reset full history
  currentChapterNumber = 0;
  currentSectionType = 'prologue';
  
  chatMessages = []; // Clear chat history
  renderChatMessages(); // Update UI

  storyContentElement.innerHTML = `<p class="placeholder-text">The ledgers are blank... A new financial conspiracy for ${PROTAGONIST_NAME} is being drafted...</p>`;
  clearChoices();
  updateButtonAndChoiceUI(); 
  updateStatus(`✨ A new stratagem begins for ${PROTAGONIST_NAME}... Generating initial avenues within ${PRIMARY_ENTITY}.`);
  
  await fetchAndDisplayChoices();
}

async function fetchAndDisplayChoices() {
  if (!GEMINI_API_KEY) {
    updateStatus("🔴 API_KEY is missing. Cannot fetch choices.", true);
    isGenerating = false; 
    updateButtonAndChoiceUI();
    return;
  }
  isGenerating = true;
  clearChoices(); 
  updateButtonAndChoiceUI();
  updateStatus(`⏳ Consulting financial oracles for ${currentSectionType === 'chapter' ? `Chapter ${currentChapterNumber}` : currentSectionType} pathways for ${PROTAGONIST_NAME}... This corporate intrigue deepens indefinitely.`);

  const choicePromptInstruction = `The story is designed to be an infinitely unfolding narrative. Each set of choices should open new avenues for ${PROTAGONIST_NAME}'s involvement and deepen the existing mysteries surrounding ${PRIMARY_ENTITY} and its connection to esoteric financial powers, rather than driving towards a single conclusion. Ensure choices lead to deeper, more complex aspects of this corporate conspiracy, touching upon themes of quantum finance, hidden data networks, reality-distorting financial instruments, and secret cabals within the banking world.`;

  const historyForPrompt = storyContext.length > 0
    ? `Here is the full story so far, detailing previous choices and their outcomes for ${PROTAGONIST_NAME}:\n\n${storyContext.join('\n\n---\n\n')}`
    : `This is the beginning of the story for ${PROTAGONIST_NAME}.`;


  let choicePrompt = `You are an AI Dungeon Master for an interactive corporate thriller titled "${BOOK_TITLE_BASE}". The story revolves around ${PROTAGONIST_NAME} and their deep involvement with "${PRIMARY_ENTITY}," which is a front for, or target of, esoteric financial/technological conspiracies. The story aims to explore themes of "quantum banking," secret societies within high finance, and technologies that could "exceed current understanding of financial reality."
${choicePromptInstruction}

Current story phase: ${currentSectionType === 'chapter' ? `Chapter ${currentChapterNumber}` : currentSectionType}.

${historyForPrompt}

Based on ALL the above (especially the LATEST events and choices in the story so far), generate ${NUM_CHOICES_TO_GENERATE} distinct, intriguing, and suspenseful plot continuation choices for ${PROTAGONIST_NAME}. Each choice must:
1.  Directly and logically follow from the current story state detailed above.
2.  Deepen ${PROTAGONIST_NAME}'s involvement with the conspiracy themes related to ${PRIMARY_ENTITY}, especially esoteric finance, quantum technology, data manipulation, and powerful hidden factions.
3.  Be concise (under 150 characters), actionable, and phrased as something ${PROTAGONIST_NAME} might decide to do, investigate, or authorize.
4.  Vary in terms of risk, approach, or focus, offering diverse paths into the infinitely deepening corporate conspiracy.

Return ONLY the choices, each on a new line. Do not add any other text, numbering, or explanations.
Example format:
Authorize the 'Project Chimera' quantum ledger activation.
Investigate the anomalous data surge from the Zurich off-site server.
Arrange a discreet meeting with the alleged whistleblower from the 'Argent Syndicate'.
`;

  try {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-04-17',
        contents: [{ role: "user", parts: [{text: choicePrompt }] }],
        config: { temperature: 0.8 } 
    });
    const rawChoicesText = response.text;
    const choices = rawChoicesText.split('\n').map(c => c.trim()).filter(c => c.length > 10 && c.length < 200); 

    if (choices.length === 0) {
      updateStatus(`⚠️ The AI could not determine clear paths forward for ${PROTAGONIST_NAME}. The corporate structure guards its secrets. Attempting to generate a general continuation or restart may be needed.`, true);
      displayChoices([`[AI was unable to generate distinct choices. Click 'Restart Stratagem' if this persists.]`]);
    } else {
      displayChoices(choices.slice(0, NUM_CHOICES_TO_GENERATE)); 
      updateStatus(`👁️‍🗨️ Paths have been revealed for ${PROTAGONIST_NAME} in the ${currentSectionType === 'chapter' ? `Chapter ${currentChapterNumber}` : currentSectionType}. Choose the next move in this endless corporate game.`);
    }
  } catch (error) {
    console.error("Error fetching choices:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`❌ Error fetching choices: ${errorMessage}. The secure lines are down. Try restarting.`, true);
    displayChoices([`[Error fetching choices: ${errorMessage.substring(0,100)}... Click 'Restart Stratagem'.]`]);
  } finally {
    isGenerating = false;
    updateButtonAndChoiceUI();
  }
}

function displayChoices(choices: string[]) {
  clearChoices(); 
  if (choices.length > 0 && !(choices.length === 1 && choices[0].startsWith("["))) { 
    choicesLabel.classList.remove('choices-label-hidden');
    choicesLabel.textContent = `Select the next move for ${PROTAGONIST_NAME} in the ${currentSectionType === 'chapter' ? `Chapter ${currentChapterNumber}` : currentSectionType}:`;
  }

  choices.forEach((choiceText, index) => {
    const button = document.createElement('button');
    button.classList.add('choice-button');
    button.textContent = choiceText;
    button.setAttribute('role', 'button'); 
    button.onclick = () => handleChoiceSelection(choiceText);
    choicesArea.appendChild(button);
  });
}

function clearChoices() {
  choicesArea.innerHTML = '';
  choicesLabel.classList.add('choices-label-hidden');
}

async function handleChoiceSelection(selectedChoice: string) {
  if (isGenerating) return;
  stopAllSpeech();
  isGenerating = true;
  updateButtonAndChoiceUI(); 
  updateStatus(`⏳ Executing ${PROTAGONIST_NAME}'s decision: "${selectedChoice.substring(0, 50)}..."`);

  await generateNextSectionCoreLogic(selectedChoice);
}

async function generateNextSectionCoreLogic(guidanceFromChoice: string) {
  if (!GEMINI_API_KEY) {
    updateStatus("🔴 API_KEY is missing. Generation cannot proceed.", true);
    isGenerating = false;
    updateButtonAndChoiceUI();
    return;
  }

  let sectionTitlePrefix = '';
  let mainPrompt = '';
  const corporateConspiracyThemeInstruction = `The story MUST embody a corporate conspiracy thriller involving ${PROTAGONIST_NAME} and ${PRIMARY_ENTITY}. Key themes include: secret factions or cabals operating within or manipulating ${PRIMARY_ENTITY} (e.g., "The Gilded Circle," "Unit 731 of Finance"), ancient conspiracies adapted to modern high finance, hidden knowledge embedded in financial algorithms or quantum systems, powerful and dangerous experimental financial technologies, cryptic data streams, global manipulation through economic warfare or control, esoteric interpretations of market forces, and the pursuit of forbidden financial power or reality-altering capabilities. The story explores themes that aim to "uncover the true depths of quantum banking and its implications, a truth that ${PROTAGONIST_NAME} is at the heart of." The tone is a dark, suspenseful thriller like "Mr. Robot" meets "The Da Vinci Code" in a corporate setting. The narrative is infinite; each chapter should deepen the mystery and complexity of ${PRIMARY_ENTITY}'s secrets.`;

  const historyForPrompt = storyContext.length > 0
    ? `Here is the full story so far, detailing all previous choices made by ${PROTAGONIST_NAME} and their resulting narrative sections within ${PRIMARY_ENTITY}:\n\n${storyContext.join('\n\n---\n\n')}`
    : `This is the beginning of the story (prologue generation) for ${PROTAGONIST_NAME} at ${PRIMARY_ENTITY}.`;

  if (currentSectionType === 'prologue') {
    sectionTitlePrefix = 'Prologue';
    mainPrompt = `You are writing the Prologue for "${BOOK_TITLE_BASE}", a corporate conspiracy thriller.
    ${corporateConspiracyThemeInstruction}

    ${historyForPrompt}
    
    The player has NOW chosen this path to begin the story for ${PROTAGONIST_NAME}: "${guidanceFromChoice}".
    Craft a compelling prologue based on this choice and ALL preceding events (if any). It should:
    1. Introduce a central mystery or a critical, unsettling event tied to a secret project, a hidden faction within ${PRIMARY_ENTITY}, or an advanced esoteric financial technology, directly following from ${PROTAGONIST_NAME}'s chosen path.
    2. Vividly set the scene and mood (e.g., a clandestine late-night board meeting, a shocking discovery in a secure data vault at ${PRIMARY_ENTITY}, an encounter with a mysterious operative).
    3. End with a strong hook or cliffhanger that directly involves ${PROTAGONIST_NAME}, pulling him deeper into the infinitely deepening conspiracy surrounding ${PRIMARY_ENTITY}.

    The AI should also generate a fitting subtitle for the Prologue, and include it in an H2 tag. Example: "<h2>Prologue: The Quantum Dividend</h2>".

    After the prologue text, provide a detailed description for a symbolic image related to THIS prologue's specific events and the advanced corporate conspiracy themes.
    Format: [IMAGE_PROMPT: Your detailed image description here. e.g., A sleek, obsidian boardroom table reflecting distorted images of ${PROTAGONIST_NAME}. On the table, a single, faintly glowing data chip etched with an unknown symbol, hinting at ${PRIMARY_ENTITY}'s hidden operations. Style: Photorealistic, corporate noir, ominous, technologically advanced.]
    Ensure this image prompt is at the very end of your response.`;
  } else if (currentSectionType === 'chapter') {
    sectionTitlePrefix = `Chapter ${currentChapterNumber}`;
    mainPrompt = `You are writing Chapter ${currentChapterNumber} of "${BOOK_TITLE_BASE}", an infinitely deepening corporate thriller starring ${PROTAGONIST_NAME}.
    ${corporateConspiracyThemeInstruction}

    ${historyForPrompt}

    The player has NOW chosen this path for this chapter for ${PROTAGONIST_NAME}: "${guidanceFromChoice}".
    Craft Chapter ${currentChapterNumber} based on this choice and ALL preceding events in the story. This chapter must:
    1.  Directly and logically follow ${PROTAGONIST_NAME}'s chosen path: "${guidanceFromChoice}" AND the full narrative context provided.
    2.  Significantly advance the main plot by introducing a new layer to the overarching conspiracy within ${PRIMARY_ENTITY} or a more profound aspect of the "quantum banking"/hidden financial power structures/data manipulation themes. ${PROTAGONIST_NAME} should uncover vital clues, face new threats from secret factions, or make a risky decision that pulls him deeper into the corporate abyss.
    3.  Deepen the corporate conspiracy themes: introduce new cryptic information, reveal fragments of ${PRIMARY_ENTITY}'s hidden history or projects, explore the philosophical or terrifying implications of the discovered technologies/powers.
    4.  Maintain high suspense and a cinematic feel. Include data breaches, tense negotiations, or high-stakes corporate espionage if appropriate.
    5.  End with a revelation, a new mystery, or a dangerous development that naturally leads to new choices and further exploration of the infinite conspiracy centered on ${PRIMARY_ENTITY} and ${PROTAGONIST_NAME}.

    The AI should also generate a fitting subtitle for Chapter ${currentChapterNumber} and include it in an H2 tag. Example: "<h2>Chapter ${currentChapterNumber}: The Ghost Ledger</h2>".

    After the chapter text, provide a detailed description for a symbolic image related to THIS chapter's specific events and the advanced corporate "Illuminati" themes.
    Format: [IMAGE_PROMPT: Your detailed image description here. e.g., A close-up of ${PROTAGONIST_NAME}'s hand hesitating over a secure terminal displaying cascading lines of corrupted financial code and glowing, unfamiliar sigils within the ${PRIMARY_ENTITY} mainframe. Style: Realistic, futuristic, suspenseful, focused on the flow of forbidden information and corporate intrigue.]
    Ensure this image prompt is at the very end of your response.`;
  }

  try {
    const sectionData = await generateSectionContentFromPrompt(sectionTitlePrefix, mainPrompt);
    
    let actualTitle = sectionTitlePrefix; 
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = sectionData.htmlContent; 
    const h2Element = tempDiv.querySelector('h2');
    if (h2Element && h2Element.textContent) {
      actualTitle = h2Element.textContent;
    } else {
        updateStatus(`🔔 AI did not provide a clear H2 title for ${sectionTitlePrefix}. Using default.`, false);
    }
    
    currentStory.push({
      type: currentSectionType as StorySectionType, 
      title: actualTitle,
      htmlContent: sectionData.htmlContent, 
      chosenPath: guidanceFromChoice,
      rawTextContent: sectionData.rawTextContent,
      sectionTitleForNarration: actualTitle 
    });

    const newSectionRecord = currentStory[currentStory.length - 1];
    
    let contextEntry = `Choice Made by ${PROTAGONIST_NAME}: "${newSectionRecord.chosenPath}"
Resulting ${newSectionRecord.type} (titled "${newSectionRecord.title}"):
${newSectionRecord.rawTextContent}`; // Use raw text for context

    if (newSectionRecord.type === 'prologue') {
      contextEntry = `To begin the story, ${PROTAGONIST_NAME} chose: "${newSectionRecord.chosenPath}"
This led to the Prologue (titled "${newSectionRecord.title}"):
${newSectionRecord.rawTextContent}`;
    }
    storyContext.push(contextEntry);

    renderStory();

    if (currentSectionType === 'prologue') {
      currentSectionType = 'chapter';
      currentChapterNumber = 1;
    } else if (currentSectionType === 'chapter') {
      currentChapterNumber++;
    }
    
    await fetchAndDisplayChoices(); 

  } catch (error) {
    console.error("Error generating section:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`❌ Error generating ${sectionTitlePrefix}: ${errorMessage}. The secure channel to ${PRIMARY_ENTITY} is compromised. Please try restarting.`, true);
    isGenerating = false;
    updateButtonAndChoiceUI(); 
    
    displayChoices([`[A critical error occurred. Please click 'Restart Stratagem'.]`]);
  } finally {
    requestAnimationFrame(() => {
        const sections = storyContentElement.querySelectorAll('section');
        if (sections.length > 0) {
            sections[sections.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else {
            storyDisplayPanel.scrollTop = storyDisplayPanel.scrollHeight;
        }
    });
  }
}


async function generateSectionContentFromPrompt(
  titleForStatus: string, 
  fullPrompt: string
): Promise<{htmlContent: string, rawTextContent: string}> {
  updateStatus(`✍️ The AI is accessing ${PRIMARY_ENTITY}'s secure servers for "${titleForStatus}"...`);
  let accumulatedText = '';
  try {
    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash-preview-04-17',
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      config: { temperature: 0.75 }, 
    });

    for await (const chunk of responseStream) {
      const text = chunk.text;
      if (text) {
        accumulatedText += text;
      }
    }
    updateStatus(`📜 Encrypted data received for "${titleForStatus}". Analyzing for visual confirmation...`);

    const imagePromptRegex = /\[IMAGE_PROMPT:\s*([\s\S]*?)\s*\]/im;
    const match = accumulatedText.match(imagePromptRegex);
    let imageHtml = '';
    let mainTextContent = accumulatedText;

    if (match && match[1]) {
      const extractedImagePrompt = match[1].trim();
      if (extractedImagePrompt) {
        updateStatus(`🎨 Rendering visual confirmation for "${titleForStatus}" based on intel: "${extractedImagePrompt.substring(0,50)}..."`);
        imageHtml = await generateImage(extractedImagePrompt, `Image for ${titleForStatus} featuring ${PROTAGONIST_NAME}`);
      }
      mainTextContent = accumulatedText.replace(imagePromptRegex, '').trim();
    } else {
      updateStatus(`🖼️ No specific visual data (image prompt) found for "${titleForStatus}". The connection is obscured.`);
    }

    const parsedTextHtml = mainTextContent ? await marked.parse(mainTextContent) : "";
    
    // Extract raw text from parsed HTML for TTS and context
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = parsedTextHtml;
    const rawTextForContext = (tempDiv.textContent || "").replace(/\s+/g, ' ').trim();

    let ttsButtonsHtml = '';
    if (ttsSupported) {
      ttsButtonsHtml = `
        <div class="tts-buttons-container">
          <button class="read-aloud-button" onclick="handleReadAloud(this)" aria-label="Read section content aloud" aria-live="polite">🔊 Read Aloud</button>
          <button class="video-narrate-button" onclick="handleVideoNarration(this)" aria-label="Create AI-generated video narration for this section" aria-live="polite">🎬 Create Video Narration</button>
        </div>`;
    }

    const finalHtml = `<section>${parsedTextHtml}${imageHtml}${ttsButtonsHtml}</section>`; 
    updateStatus(`✅ Content and visual intel manifested for "${titleForStatus}" regarding ${PROTAGONIST_NAME}.`);
    return { htmlContent: finalHtml, rawTextContent: rawTextForContext };

  } catch (error) {
    console.error(`Error generating content for ${titleForStatus}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`❌ Error in generateSectionContent for "${titleForStatus}": ${errorMessage}`, true);
    const errorSection = {
        htmlContent: `<section><h2>${titleForStatus} (Transmission Error)</h2><p class="error-text">Error generating content for this section concerning ${PROTAGONIST_NAME}: ${errorMessage}. The data stream was corrupted.</p></section>`,
        rawTextContent: `Error generating content for this section: ${errorMessage}`
    };
    return errorSection;
  }
}

async function generateImage(imagePrompt: string, altText: string): Promise<string> {
  if (!imagePrompt) {
    updateStatus(`🖼️ Image generation skipped for "${altText}": No clear visual parameters provided.`);
    return '';
  }
  try {
    const response = await ai.models.generateImages({
      model: 'imagen-3.0-generate-002',
      prompt: `Corporate espionage thriller, "${PRIMARY_ENTITY}" setting, advanced financial technology, subtle esoteric symbolism, cinematic, focused on ${PROTAGONIST_NAME}. ${imagePrompt}`,
      config: { numberOfImages: 1, outputMimeType: 'image/jpeg' },
    });

    if (response.generatedImages && response.generatedImages.length > 0 && response.generatedImages[0].image?.imageBytes) {
      const base64ImageBytes = response.generatedImages[0].image.imageBytes;
      const imageUrl = `data:image/jpeg;base64,${base64ImageBytes}`;
      updateStatus(`🖼️ Visual confirmation: Image for "${altText}" rendered.`);
      return `<figure class="story-image-figure">
                <img src="${imageUrl}" alt="${altText}" class="story-image" loading="lazy">
                <figcaption class="visually-hidden">${altText}</figcaption>
              </figure>`;
    } else {
      updateStatus(`⚠️ The visual for "${altText}" was unclear. Image generation failed to return data.`, true);
      return `<p class="warning-text"><em>The secure feed for visual: ${altText} is scrambled. No image data returned.</em></p>`;
    }
  } catch (error) {
    console.error(`Error generating image for "${altText}":`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`❌ Error materializing visual for "${altText}": ${errorMessage}`, true);
    return `<p class="error-text"><em>Error rendering image for "${altText}". ${errorMessage}.</em></p>`;
  }
}

function renderStory() {
  if (currentStory.length === 0) {
     storyContentElement.innerHTML = `<p class="placeholder-text">The intricate financial web of "${bookTitleDisplay.textContent || BOOK_TITLE_BASE}", centered on ${PROTAGONIST_NAME}, will be detailed here...</p>`;
     return;
  }
  storyContentElement.innerHTML = currentStory.map(section => section.htmlContent).join('\n');
  requestAnimationFrame(() => { 
    const sections = storyContentElement.querySelectorAll('section');
    if (sections.length > 0) {
        sections[sections.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  });
}

function updateButtonAndChoiceUI() {
  const apiKeyMissing = !GEMINI_API_KEY;
  const anyGenerationActive = isGenerating || isGeneratingVideoScript || isGeneratingChatResponse;

  // Action Button (Start/Restart)
  actionButton.disabled = (isGenerating && currentStory.length > 0) || apiKeyMissing || isGeneratingChatResponse || isGeneratingVideoScript;

  // Download Button
  downloadStoryButton.disabled = currentStory.length === 0 || anyGenerationActive || apiKeyMissing;
  
  // Choice Buttons
  const choiceButtons = choicesArea.querySelectorAll<HTMLButtonElement>('.choice-button');
  choiceButtons.forEach(button => button.disabled = anyGenerationActive || apiKeyMissing);

  // TTS and Video Narration Buttons in Story Sections
  storyContentElement.querySelectorAll<HTMLButtonElement>('.read-aloud-button, .video-narrate-button').forEach(btn => {
    btn.disabled = anyGenerationActive || apiKeyMissing;
  });

  // Chat Input and Send Button
  chatInput.disabled = anyGenerationActive || apiKeyMissing;
  chatSendButton.disabled = anyGenerationActive || apiKeyMissing;
  if (apiKeyMissing && chatToggle) chatToggle.disabled = true;


  const actionButtonTextStart = `✨ Start New Stratagem`;
  const actionButtonTextRestart = `🌀 Restart Stratagem`;
  const actionButtonLabelStart = `Start a new story for ${PROTAGONIST_NAME}`;
  const actionButtonLabelRestart = `Restart the current story for ${PROTAGONIST_NAME} from the beginning`;


  if (anyGenerationActive) {
    if (isGeneratingChatResponse) {
        actionButton.textContent = '💬 Querying Stratagem...';
        actionButton.setAttribute('aria-label', 'AI is responding to chat, please wait');
    } else if (isGeneratingVideoScript) {
        actionButton.textContent = '⏳ Crafting Narration...';
        actionButton.setAttribute('aria-label', 'Generating video narration, please wait');
    } else { // isGenerating (main story)
        actionButton.textContent = '⏳ Processing Intel...';
        actionButton.setAttribute('aria-label', 'Generating content, please wait');
    }
    downloadStoryButton.setAttribute('aria-label', 'Wait for generation to complete before downloading');
    if (choicesArea.innerHTML.trim() === '' && isGenerating) { 
        choicesLabel.classList.remove('choices-label-hidden');
        choicesLabel.textContent = `The AI is drafting ${PROTAGONIST_NAME}'s next move...`;
    }
  } else if (apiKeyMissing) {
    actionButton.textContent = "API KEY MISSING";
    actionButton.setAttribute('aria-label', 'API Key is missing, application disabled');
    downloadStoryButton.setAttribute('aria-label', 'API Key is missing, download disabled');
    if (choicesArea.innerHTML.trim() === '') { 
        clearChoices(); 
        choicesLabel.classList.remove('choices-label-hidden');
        choicesLabel.textContent = `Application disabled due to missing API key.`;
    }
  } else { // No generation active, API key present
    if (currentStory.length === 0) {
      actionButton.textContent = actionButtonTextStart;
      actionButton.setAttribute('aria-label', actionButtonLabelStart);
      downloadStoryButton.setAttribute('aria-label', 'No story content to download yet');
      if (choicesArea.innerHTML.trim() === '') { 
         clearChoices(); 
         choicesLabel.classList.remove('choices-label-hidden');
         choicesLabel.textContent = `Awaiting ${PROTAGONIST_NAME}'s first directive.`;
      }
    } else { 
      actionButton.textContent = actionButtonTextRestart;
      actionButton.setAttribute('aria-label', actionButtonLabelRestart);
      downloadStoryButton.setAttribute('aria-label', 'Download the current story as an HTML file');
      if (choicesArea.innerHTML.trim() === '' && !isGenerating) { 
          choicesLabel.classList.remove('choices-label-hidden');
          choicesLabel.textContent = 'Awaiting new directives or recovery from a system glitch...';
      }
    }
  }
}

// --- Text-to-Speech Functionality ---
function getSectionTextForSpeech(sectionElement: HTMLElement): string {
  const clone = sectionElement.cloneNode(true) as HTMLElement;
  clone.querySelector('.tts-buttons-container')?.remove();
  clone.querySelector('figure.story-image-figure')?.remove();
  clone.querySelectorAll('.error-text, .warning-text').forEach(el => el.remove());
  return clone.textContent?.replace(/\s+/g, ' ').trim() || "";
}

function handleReadAloud(buttonElement: HTMLButtonElement) {
  if (!ttsSupported || !buttonElement || isGeneratingVideoScript || isGenerating || isGeneratingChatResponse) return;

  const sectionElement = buttonElement.closest('section');
  if (!sectionElement) return;

  const synth = window.speechSynthesis;
  
  // If this button's section is already the one being read aloud, stop it.
  if (synth.speaking && currentlySpeakingSectionElement === sectionElement && currentSpeechUtterance) {
    synth.cancel(); // This will trigger onend, which resets states.
    return;
  }

  // Stop any ongoing speech (ReadAloud or VideoNarration) before starting new ReadAloud
  stopAllSpeech();
  
  const textToSpeak = getSectionTextForSpeech(sectionElement);
  if (!textToSpeak.trim()) {
    updateStatus("ℹ️ No audible intel in this section for 'Read Aloud'.", false);
    return;
  }

  currentSpeechUtterance = new SpeechSynthesisUtterance(textToSpeak);
  currentSpeechUtterance.lang = 'en-US';

  currentSpeechUtterance.onstart = () => {
    buttonElement.textContent = '⏹️ Stop Reading';
    buttonElement.setAttribute('aria-label', 'Stop reading section content');
    currentlySpeakingSectionElement = sectionElement;
  };

  currentSpeechUtterance.onend = () => {
    if (currentlySpeakingSectionElement === sectionElement) { // Check if it's still the active section
        buttonElement.textContent = '🔊 Read Aloud';
        buttonElement.setAttribute('aria-label', 'Read section content aloud');
        currentSpeechUtterance = null;
        currentlySpeakingSectionElement = null;
    }
  };

  currentSpeechUtterance.onerror = (event) => {
    console.error('Speech synthesis error (ReadAloud):', event.error);
    updateStatus(`⚠️ Error reading aloud: ${event.error}.`, true);
     if (currentlySpeakingSectionElement === sectionElement) {
        buttonElement.textContent = '🔊 Read Aloud';
        buttonElement.setAttribute('aria-label', 'Read section content aloud');
        currentSpeechUtterance = null;
        currentlySpeakingSectionElement = null;
    }
  };
  
  synth.speak(currentSpeechUtterance);
}

async function fetchVideoNarrationScript(sectionText: string, sectionTitle: string): Promise<string> {
  updateStatus("🤖 Accessing AI consciousness for narration script...", false);
  const prompt = `You are an AI video narrator. The user will provide you with the text of a story chapter. Your task is to create a concise and engaging narration script based on this text. The script should be suitable for a short video segment where an image related to the chapter is displayed.
Focus on:
- Key events and actions of ${PROTAGONIST_NAME}.
- The atmosphere and suspense of the scene.
- Thematic elements related to ${PRIMARY_ENTITY} and the corporate conspiracy.
The script should be approximately 3 to 6 sentences long.
Return ONLY the narration script. Do not include any other explanatory text, titles, or formatting.

Chapter Title (for context, not to be narrated): "${sectionTitle}"
Story Text to Narrate:
---
${sectionText}
---
Narration Script:`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-04-17',
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.7 } // Slightly lower temp for more focused script
    });
    const script = response.text.trim();
    if (!script) {
        updateStatus("⚠️ AI returned an empty narration script. The story's essence remains elusive.", true);
        return "";
    }
    updateStatus("📜 AI narration script received.", false);
    return script;
  } catch (error) {
    console.error("Error fetching AI narration script:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`❌ Error generating narration script: ${errorMessage}`, true);
    return "";
  }
}

async function handleVideoNarration(buttonElement: HTMLButtonElement) {
  if (!ttsSupported || !buttonElement || isGenerating || isGeneratingVideoScript || isGeneratingChatResponse) return;

  const sectionElement = buttonElement.closest('section');
  if (!sectionElement) return;

  const synth = window.speechSynthesis;

  // If this button's section is already the one being narrated, stop it.
  if (synth.speaking && currentlyVideoNarratingSectionElement === sectionElement && currentVideoNarrationUtterance) {
    synth.cancel(); // This will trigger onend for the video narration utterance.
    return;
  }

  // Stop any ongoing speech (ReadAloud or another VideoNarration)
  stopAllSpeech();

  isGeneratingVideoScript = true;
  buttonElement.textContent = '⏳ Generating Script...';
  buttonElement.disabled = true;
  updateButtonAndChoiceUI(); // Reflect disabling other buttons

  // Find the corresponding story section to get raw text and title
  const storySectionIndex = Array.from(storyContentElement.querySelectorAll('section')).indexOf(sectionElement);
  const storySectionData = currentStory[storySectionIndex];

  if (!storySectionData || !storySectionData.rawTextContent || !storySectionData.sectionTitleForNarration) {
    updateStatus("⚠️ Cannot generate narration. Section data is incomplete.", true);
    isGeneratingVideoScript = false;
    buttonElement.textContent = '🎬 Create Video Narration';
    buttonElement.disabled = false;
    updateButtonAndChoiceUI();
    return;
  }
  
  const narrationScript = await fetchVideoNarrationScript(storySectionData.rawTextContent, storySectionData.sectionTitleForNarration);
  
  isGeneratingVideoScript = false;
  buttonElement.disabled = false; // Re-enable button before potential early exit
  updateButtonAndChoiceUI();

  if (!narrationScript) {
    // fetchVideoNarrationScript already updated status with error
    buttonElement.textContent = '🎬 Create Video Narration';
    return;
  }

  currentVideoNarrationUtterance = new SpeechSynthesisUtterance(narrationScript);
  currentVideoNarrationUtterance.lang = 'en-US';

  currentVideoNarrationUtterance.onstart = () => {
    buttonElement.textContent = '⏹️ Stop Video Narration';
    buttonElement.setAttribute('aria-label', 'Stop AI-generated video narration');
    currentlyVideoNarratingSectionElement = sectionElement;
  };

  currentVideoNarrationUtterance.onend = () => {
    if (currentlyVideoNarratingSectionElement === sectionElement) {
        buttonElement.textContent = '🎬 Create Video Narration';
        buttonElement.setAttribute('aria-label', 'Create AI-generated video narration for this section');
        currentVideoNarrationUtterance = null;
        currentlyVideoNarratingSectionElement = null;
    }
  };

  currentVideoNarrationUtterance.onerror = (event) => {
    console.error('Speech synthesis error (VideoNarration):', event.error);
    updateStatus(`⚠️ Error playing video narration: ${event.error}.`, true);
    if (currentlyVideoNarratingSectionElement === sectionElement) {
        buttonElement.textContent = '🎬 Create Video Narration';
        buttonElement.setAttribute('aria-label', 'Create AI-generated video narration for this section');
        currentVideoNarrationUtterance = null;
        currentlyVideoNarratingSectionElement = null;
    }
  };

  synth.speak(currentVideoNarrationUtterance);
}


// --- Story Download Functionality ---
function generateStoryHTML(): string {
  if (currentStory.length === 0) return "";

  const bookTitle = bookTitleDisplay.textContent || BOOK_TITLE_BASE;

  const storySectionsCombined = currentStory.map(storySection => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = storySection.htmlContent; 
    
    tempDiv.querySelectorAll('.read-aloud-button, .video-narrate-button, .tts-buttons-container').forEach(btn => btn.remove());
    
    return tempDiv.innerHTML; 
  }).join('\n\n'); 

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bookTitle}</title>
  <style>
    body { font-family: Georgia, 'Times New Roman', Times, serif; line-height: 1.7; margin: 20px auto; max-width: 800px; background-color: #f9f9f9; color: #222; padding: 10px; }
    h1 { font-family: 'Cinzel Decorative', serif; color: #4B0082; text-align: center; margin-bottom: 1.5em; font-size: 2.5em; }
    h2 { font-family: 'Cinzel Decorative', serif; color: #6A0DAD; font-size: 1.8em; margin-top: 1.5em; margin-bottom: 0.8em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
    p { margin-bottom: 1.2em; text-align: justify; }
    img.story-image { display: block; max-width: 80%; height: auto; margin: 1.5em auto; border: 3px solid #ddd; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    figure.story-image-figure { margin: 1.5em 0; padding: 0; display: flex; justify-content: center; }
    figcaption.visually-hidden { display: none; } /* Standard practice for screen readers if alt text is good */
    section { margin-bottom: 2em; padding-bottom: 1em; border-bottom: 1px dashed #ccc; }
    section:last-of-type { border-bottom: none; }
    blockquote { margin: 1em 1.5em; padding: 0.8em 1.2em; border-left: 3px solid #8A2BE2; font-style: italic; color: #555; background-color: #f3e9fA; border-radius: 0 3px 3px 0; }
    .error-text { color: #D8000C; background-color: #FFD2D2; padding: 0.5em; border-radius: 3px; font-weight: bold; }
    .warning-text { color: #9F6000; background-color: #FEEFB3; padding: 0.5em; border-radius: 3px; font-style: italic; }
  </style>
</head>
<body>
  <h1>${bookTitle}</h1>
  ${storySectionsCombined}
</body>
</html>`;
}

function handleDownloadStoryClick() {
  if (currentStory.length === 0 || isGenerating || isGeneratingVideoScript || isGeneratingChatResponse) {
    updateStatus("ℹ️ No story content to download or an operation is in progress.", false);
    return;
  }

  updateStatus("📦 Preparing story for download...", false);
  try {
    const htmlContent = generateStoryHTML();
    if (!htmlContent) {
      updateStatus("⚠️ Could not generate HTML for download. Story might be empty.", true);
      return;
    }

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = (bookTitleDisplay.textContent || BOOK_TITLE_BASE).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    a.href = url;
    a.download = `${safeTitle}_${new Date().toISOString().slice(0,10)}.html`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    updateStatus("✅ Story downloaded successfully!", false);

  } catch (error) {
    console.error("Error downloading story:", error);
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    updateStatus(`❌ Error downloading story: ${errorMessage}`, true);
  }
}

// --- Chat Functionality ---
function handleChatToggleClick() {
  isChatExpanded = !isChatExpanded;
  chatPanelContent.classList.toggle('chat-panel-hidden', !isChatExpanded);
  chatToggle.setAttribute('aria-expanded', String(isChatExpanded));
  chatToggleIcon.textContent = isChatExpanded ? '▲' : '▼';
}

async function renderChatMessages() {
    if (!chatHistoryDisplay) return;
    chatHistoryDisplay.innerHTML = ''; // Clear previous messages

    if (chatMessages.length === 0) {
        const p = document.createElement('p');
        p.textContent = "Ask the Stratagem a question about the current story...";
        p.style.fontStyle = "italic";
        p.style.textAlign = "center";
        p.style.color = "#777";
        chatHistoryDisplay.appendChild(p);
        return;
    }

    for (const msg of chatMessages) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('chat-message', `chat-message-${msg.sender}`);
        
        if (msg.htmlText) {
            messageDiv.innerHTML = msg.htmlText; // Use pre-parsed HTML
        } else {
            try {
                messageDiv.innerHTML = await marked.parse(msg.text.replace(/^```(\w*)?\s*\n?([\s\S]*?)\n?\s*```$/s, '$2')); // Basic markdown for user text too
            } catch (e) {
                messageDiv.textContent = msg.text; // Fallback to plain text
            }
        }
        chatHistoryDisplay.appendChild(messageDiv);
    }
    chatHistoryDisplay.scrollTop = chatHistoryDisplay.scrollHeight; // Scroll to the bottom
}


async function handleSendChatMessage() {
    const userText = chatInput.value.trim();
    if (!userText || isGenerating || isGeneratingVideoScript || isGeneratingChatResponse || !GEMINI_API_KEY) {
        return;
    }

    isGeneratingChatResponse = true;
    updateButtonAndChoiceUI();
    
    chatMessages.push({ sender: 'user', text: userText });
    await renderChatMessages(); // Show user's message immediately
    chatInput.value = '';
    chatInput.focus();

    const thinkingMessage: ChatMessage = { sender: 'ai', text: "The Stratagem is considering your query..." };
    chatMessages.push(thinkingMessage);
    await renderChatMessages();


    let systemInstruction = `You are the "Voice of the Stratagem," an omniscient narrator AI embodying the interactive story "${BOOK_TITLE_BASE}" which stars ${PROTAGONIST_NAME} and revolves around ${PRIMARY_ENTITY}. Your knowledge is STRICTLY LIMITED to the events, characters, and details that have ALREADY BEEN WRITTEN AND REVEALED in the story so far. The user is asking you a question about this story.

    - Answer based ONLY on the provided story context.
    - Do NOT invent new plot points, characters, or speculate beyond what has been explicitly stated in the story.
    - If the story hasn't started yet (i.e., story context is empty), inform the user that the narrative hasn't begun.
    - If the question cannot be answered from the current story context, clearly state that the information is not yet part of the revealed stratagem or is unknown at this point in the narrative.
    - Keep your answers concise and directly address the user's question.
    - Maintain a slightly mysterious, insightful, and thematic tone appropriate for a corporate conspiracy thriller.
    - Do not refer to yourself as an AI or language model. You are the Voice of the Stratagem.`;

    const currentStoryState = storyContext.join('\n\n---\n\n');
    
    let chatPrompt: string;
    if (currentStory.length === 0) {
        chatPrompt = `System: The story for ${PROTAGONIST_NAME} at ${PRIMARY_ENTITY} has not yet begun.
User asks: "${userText}"
Voice of the Stratagem (Respond directly to the user based on the system instruction that the story has not started):`;
    } else {
        chatPrompt = `System Instruction: ${systemInstruction}

Full Story Context So Far:
---
${currentStoryState}
---

User asks: "${userText}"

Voice of the Stratagem (Answer based ONLY on the story context and system instruction):`;
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-04-17',
            contents: [{ role: "user", parts: [{ text: chatPrompt }] }],
            config: { temperature: 0.5 }
        });

        let aiResponseText = response.text.trim();
        if (!aiResponseText) {
            aiResponseText = "The Stratagem offers no comment at this time.";
        }
        
        // Remove the "thinking" message and add the actual AI response
        chatMessages.pop(); 
        const aiHtmlText = await marked.parse(aiResponseText);
        chatMessages.push({ sender: 'ai', text: aiResponseText, htmlText: aiHtmlText });

    } catch (error) {
        console.error("Error fetching chat response:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        chatMessages.pop(); // Remove "thinking" message
        chatMessages.push({ sender: 'system', text: `Error communicating with the Stratagem's core: ${errorMessage.substring(0,100)}...` });
    } finally {
        isGeneratingChatResponse = false;
        await renderChatMessages();
        updateButtonAndChoiceUI();
    }
}
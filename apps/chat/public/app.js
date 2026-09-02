// @ts-check

const storageKey = "gremlin.chat.current.v1";
const messagesCandidate = document.querySelector("#messages");
const statusCandidate = document.querySelector("#status");
const formCandidate = document.querySelector("#chat-form");
const inputCandidate = document.querySelector("#message");
const sendCandidate = document.querySelector("#send");
const newConversationCandidate = document.querySelector("#new-conversation");

if (
  !(messagesCandidate instanceof HTMLElement) ||
  !(statusCandidate instanceof HTMLElement) ||
  !(formCandidate instanceof HTMLFormElement) ||
  !(inputCandidate instanceof HTMLTextAreaElement) ||
  !(sendCandidate instanceof HTMLButtonElement) ||
  !(newConversationCandidate instanceof HTMLButtonElement)
) {
  throw new Error("Gremlin Chat UI could not initialize");
}

const messagesElement = messagesCandidate;
const statusElement = statusCandidate;
const formElement = formCandidate;
const inputElement = inputCandidate;
const sendButton = sendCandidate;
const newConversationButton = newConversationCandidate;

/** @typedef {{ content: string, persisted: boolean | null, role: "user" | "assistant" }} UiMessage */
/** @typedef {{ conversationId: string, messages: UiMessage[] }} ChatState */

/** @returns {ChatState} */
function createState() {
  return { conversationId: crypto.randomUUID(), messages: [] };
}

/** @returns {ChatState} */
function loadState() {
  try {
    const stored = localStorage.getItem(storageKey);

    if (stored === null) {
      return createState();
    }

    const candidate = JSON.parse(stored);

    if (
      typeof candidate?.conversationId !== "string" ||
      !Array.isArray(candidate?.messages)
    ) {
      return createState();
    }

    return candidate;
  } catch {
    return createState();
  }
}

let state = loadState();
let busy = false;

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

/** @param {string} text @param {boolean} [error] */
function setStatus(text, error = false) {
  statusElement.textContent = text;
  statusElement.classList.toggle("error", error);
}

function render() {
  messagesElement.replaceChildren();

  if (state.messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "A fresh conversation. Nothing hoarded yet.";
    messagesElement.append(empty);
    return;
  }

  for (const message of state.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;

    const content = document.createElement("span");
    content.textContent = message.content;
    article.append(content);

    const persistence = document.createElement("small");
    persistence.className = "persistence";

    if (message.persisted === null) {
      persistence.textContent = "Persistence pending";
    } else if (message.persisted) {
      persistence.textContent = "Stored in Gremlin Prime";
    } else {
      persistence.textContent = "Not stored in Gremlin Prime";
      persistence.classList.add("failed");
    }

    article.append(persistence);
    messagesElement.append(article);
  }

  messagesElement.scrollTop = messagesElement.scrollHeight;
}

/**
 * @param {Response} response
 * @param {(event: string, data: Record<string, unknown>) => void} onEvent
 */
async function consumeEventStream(response, onEvent) {
  if (response.body === null) {
    throw new Error("The chat response had no stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      let event = "message";
      const dataLines = [];

      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event: ")) {
          event = line.slice(7);
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        }
      }

      if (dataLines.length > 0) {
        onEvent(event, JSON.parse(dataLines.join("\n")));
      }
    }

    if (done) {
      break;
    }
  }
}

/** @param {boolean} value */
function setBusy(value) {
  busy = value;
  inputElement.disabled = value;
  sendButton.disabled = value;
  newConversationButton.disabled = value;
}

formElement.addEventListener("submit", async (event) => {
  event.preventDefault();

  const content = inputElement.value.trim();

  if (busy || content.length === 0) {
    return;
  }

  /** @type {UiMessage} */
  const userMessage = { content, persisted: null, role: "user" };
  /** @type {UiMessage} */
  const assistantMessage = {
    content: "",
    persisted: null,
    role: "assistant"
  };
  state.messages.push(userMessage, assistantMessage);
  inputElement.value = "";
  saveState();
  render();
  setBusy(true);
  setStatus("Archiving your message…");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: state.conversationId,
        messages: state.messages
          .slice(0, -1)
          .filter((message) => message === userMessage || message.persisted !== false)
          .map(({ content: text, role }) => ({
            content: text,
            role
          }))
      })
    });

    if (!response.ok) {
      assistantMessage.persisted = false;
      userMessage.persisted = false;
      throw new Error("The message was not archived or sent to the model");
    }

    setStatus("Gremlin is thinking…");

    await consumeEventStream(response, (streamEvent, data) => {
      if (streamEvent === "delta" && typeof data.content === "string") {
        assistantMessage.content += data.content;
        render();
      } else if (streamEvent === "interaction" && data.role === "user") {
        userMessage.persisted = data.persisted === true;
      } else if (streamEvent === "interaction" && data.role === "assistant") {
        assistantMessage.persisted = data.persisted === true;
      } else if (streamEvent === "complete") {
        setStatus(
          data.persisted === true
            ? "Response complete and safely hoarded."
            : "Response complete, but it was not stored in Gremlin Prime.",
          data.persisted !== true
        );
      } else if (streamEvent === "error") {
        assistantMessage.persisted = data.partialPersisted === true;
        setStatus(
          data.partialPersisted === true
            ? "The model stream failed; the partial response was hoarded."
            : "The model stream failed and the response was not hoarded.",
          true
        );
      }

      saveState();
    });
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "The chat request failed.",
      true
    );
  } finally {
    if (assistantMessage.content.length === 0) {
      state.messages = state.messages.filter((message) => message !== assistantMessage);
    }

    saveState();
    render();
    setBusy(false);
    inputElement.focus();
  }
});

newConversationButton.addEventListener("click", () => {
  if (busy || !window.confirm("Start a new conversation?")) {
    return;
  }

  state = createState();
  saveState();
  render();
  setStatus("New conversation ready.");
  inputElement.focus();
});

render();

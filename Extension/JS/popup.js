const scanButton = document.querySelector("#scan-button");
const statusMessage = document.querySelector("#status-message");

scanButton.addEventListener("click", () =>{
    statusMessage.textContent=
    "Scan requested. Gmail reading is not connected yet";
})


//interface elementing 
// Interface elements
const addSenderButton = document.querySelector("#add-sender-button");
const senderForm = document.querySelector("#sender-form");
const senderEmailInput = document.querySelector("#sender-email");
const cancelSenderButton = document.querySelector("#cancel-sender-button");
const senderList = document.querySelector("#sender-list");
const sendersEmptyState = document.querySelector("#senders-empty-state");

// Temporary state: persistence comes next.
const senders = [];

function closeSenderForm() {
  senderForm.reset();
  senderEmailInput.setCustomValidity("");
  senderForm.hidden = true;
  addSenderButton.focus();
}

addSenderButton.addEventListener("click", () => {
  senderForm.hidden = false;
  senderEmailInput.focus();
});

cancelSenderButton.addEventListener("click", closeSenderForm);

senderForm.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSenderForm();
  }
});

// Clear previous validation errors when the user edits the address.
senderEmailInput.addEventListener("input", () => {
  senderEmailInput.setCustomValidity("");
});

function renderSenders() {
  senderList.replaceChildren();
  sendersEmptyState.hidden = senders.length > 0;

  for (const email of senders) {
    const item = document.createElement("li");
    item.className = "sender-card";

    const address = document.createElement("span");
    address.textContent = email;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${email}`);

    removeButton.addEventListener("click", () => {
      const index = senders.indexOf(email);
      senders.splice(index, 1);

      renderSenders();
      statusMessage.textContent = `Removed ${email}.`;

      // The clicked button no longer exists, so restore useful focus.
      const nextButton =
        senderList.children[index]?.querySelector("button");
      const previousButton =
        senderList.children[index - 1]?.querySelector("button");

      (nextButton ?? previousButton ?? addSenderButton).focus();
    });

    item.append(address, removeButton);
    senderList.append(item);
  }
}

senderForm.addEventListener("submit", (event) => {
  // Prevent the form from navigating away and reloading the popup.
  event.preventDefault();

  const email = senderEmailInput.value.trim();
  senderEmailInput.value = email;
  senderEmailInput.setCustomValidity("");

  if (email.length > 254) {
    senderEmailInput.setCustomValidity(
      "Use an email address of 254 characters or fewer."
    );
  }

  if (!senderForm.reportValidity()) {
    return;
  }

  // For this tool, treat differently capitalised addresses as duplicates.
  const alreadyExists = senders.some(
    (sender) => sender.toLowerCase() === email.toLowerCase()
  );

  if (alreadyExists) {
    senderEmailInput.setCustomValidity(
      "You are already monitoring this sender."
    );
    senderEmailInput.reportValidity();
    return;
  }

  senders.push(email);
  renderSenders();
  closeSenderForm();

  statusMessage.textContent =
    `Added ${email} to this session. Gmail monitoring is not connected yet.`;
});

renderSenders();
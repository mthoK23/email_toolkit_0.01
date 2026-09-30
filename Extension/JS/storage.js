const SENDERS_STORAGE_KEY ="monitoredSenders";

function validateSenders(senders){
    if (!Array.isArray(senders)){
        throw new Error("Stored senders must be a list.");
    }

    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.required = true;

    const seen = new Set();

    for (const sender of senders){
        if (
            typeof sender !== "string" ||
            sender.length > 254 ||
            sender !== sender.trim()
        ){
            throw new Error("Invalid sender data.");
        }

        emailInput.value = sender;

        if (!emailInput.checkValidity()){
            throw new Error("Invalid sender email address");
        }

        const key = sender.toLowerCase();

        if (seen.has(key)){
            throw new Error("Duplicate sender data");
        }

        seen.add(key);
        }
    }

    async function loadSenders(){
        const result = await chrome.storage.local.get(SENDERS_STORAGE_KEY);
        const storedSenders= result[SENDERS_STORAGE_KEY];

        if (storedSenders === undefined){
            return[];
        }

        return normaliseSenderRecords(storedSenders);
    }

    async function saveSenders(senders){
        const records = normaliseSenderRecords(senders);

        await chrome.storage.local.set({
            [SENDERS_STORAGE_KEY]: records
        });
}

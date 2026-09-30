// Accept the original address-only format without writing during loading.
function normaliseSenderRecords(storedSenders) {
  if (!Array.isArray(storedSenders)) throw new Error("Stored senders must be a list.");
  const records = storedSenders.map((sender) => {
    if (typeof sender === "string") return { email: sender, subjectContains: "" };
    if (!sender || typeof sender !== "object" || Array.isArray(sender)) {
      throw new Error("Invalid sender record.");
    }
    if (typeof sender.subjectContains !== "string" || sender.subjectContains.length > 200) {
      throw new Error("Invalid subject filter.");
    }
    return { email: sender.email, subjectContains: sender.subjectContains.trim() };
  });
  validateSenders(records.map((sender) => sender.email));
  return records;
}


require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { OpenAI } = require("openai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Initialize Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Assistant ID - You'll need to create this assistant first
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

// Validate required environment variables
if (!ASSISTANT_ID) {
  console.error("ERROR: OPENAI_ASSISTANT_ID environment variable is not set!");
  process.exit(1);
}

console.log("Using Assistant ID:", ASSISTANT_ID);

// Lead notification phone number
const LEAD_NOTIFICATION_PHONE = "+17478375004";

// Create a simple in-memory context store with thread IDs
const conversationContexts = new Map();

// Conversation context handler
function getOrCreateContext(phoneNumber) {
  if (!conversationContexts.has(phoneNumber)) {
    conversationContexts.set(phoneNumber, {
      threadId: null,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    });
  } else {
    // Update last activity timestamp
    const context = conversationContexts.get(phoneNumber);
    context.lastUpdated = Date.now();
  }
  return conversationContexts.get(phoneNumber);
}

// Clean expired contexts (older than 24 hours)
function cleanupExpiredContexts() {
  const oneDayAgo = Date.now() - 86400000; // 24 hours in milliseconds
  for (const [phoneNumber, context] of conversationContexts.entries()) {
    if (context.lastUpdated < oneDayAgo) {
      conversationContexts.delete(phoneNumber);
    }
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredContexts, 60 * 60 * 1000);

// Function to send qualified lead notification
async function sendQualifiedLeadNotification(leadInfo) {
  try {
    const messageBody = `New Qualified Lead:
Full Name: ${leadInfo.fullName}
Phone: ${leadInfo.phone}
City: ${leadInfo.city}
Summary of Legal Concern: ${leadInfo.legalConcern}`;

    const twilioMessage = await client.messages.create({
      body: messageBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: LEAD_NOTIFICATION_PHONE,
    });

    console.log("Lead notification sent:", twilioMessage.sid);
    return twilioMessage.sid;
  } catch (error) {
    console.error("Error sending lead notification:", error);
    throw error;
  }
}

// Handle function calls from the assistant
async function handleFunctionCall(toolCall) {
  const functionName = toolCall.function.name;
  const functionArgs = JSON.parse(toolCall.function.arguments);

  console.log("Function called:", functionName, functionArgs);

  switch (functionName) {
    case "send_qualified_lead":
      try {
        await sendQualifiedLeadNotification(functionArgs);
        return {
          tool_call_id: toolCall.id,
          output:
            "Lead information has been successfully sent to the law firm. Thank you for providing all the necessary details!",
        };
      } catch (error) {
        return {
          tool_call_id: toolCall.id,
          output:
            "There was an error sending the lead information. Please try again.",
        };
      }
    default:
      return {
        tool_call_id: toolCall.id,
        output: "Unknown function called.",
      };
  }
}

// Current time API endpoint
app.post("/api/current-time", (req, res) => {
  const date = new Date();
  // Convert to EST (UTC-5)
  const estDate = new Date(
    date.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );

  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const day = estDate.getDate();
  const month = months[estDate.getMonth()];
  const year = estDate.getFullYear();

  // Format hours for 12-hour clock with AM/PM
  let hours = estDate.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12; // Convert 0 to 12

  // Ensure minutes are padded with leading zero if needed
  const minutes = estDate.getMinutes().toString().padStart(2, "0");

  const formattedDate = `${day}${getDaySuffix(day)} ${month} ${year} ${hours}:${minutes} ${ampm} EST`;

  res.json({
    current_time: formattedDate,
  });
});

function getDaySuffix(day) {
  if (day > 3 && day < 21) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

// Lionhead SMS endpoint
app.post("/lionhead-sms", async (req, res) => {
  try {
    console.log("Received message data:", req.body);

    // Handle both formats - custom format and Twilio webhook format
    let message, phone_number;

    if (req.body.customData && req.body.customData.message) {
      // Custom format (your original format)
      message = req.body.customData.message;
      phone_number = req.body.phone;
    } else if (req.body.Body && req.body.From) {
      // Twilio webhook format
      message = req.body.Body;
      phone_number = req.body.From;
    } else {
      console.error("Unrecognized message format:", req.body);
      return res.status(400).json({
        error: "Message and phone number are required",
        receivedFormat: Object.keys(req.body),
      });
    }

    console.log("Message:", message);
    console.log("Phone Number:", phone_number);

    if (!message || !phone_number) {
      return res
        .status(400)
        .json({ error: "Message and phone number are required" });
    }

    // Normalize phone number
    const normalizedPhoneNumber = phone_number;

    // Get or create conversation context
    const context = getOrCreateContext(normalizedPhoneNumber);

    // Create a new thread if one doesn't exist
    if (!context.threadId) {
      const thread = await openai.beta.threads.create();
      context.threadId = thread.id;
      console.log("Created new thread:", thread.id);
    }

    // Add the user's message to the thread
    await openai.beta.threads.messages.create(context.threadId, {
      role: "user",
      content: message,
    });

    // Run the assistant - USE THE ENVIRONMENT VARIABLE, NOT HARDCODED ID
    const run = await openai.beta.threads.runs.create(context.threadId, {
      assistant_id: ASSISTANT_ID,
    });

    // Wait for the run to complete
    let runStatus = await openai.beta.threads.runs.retrieve(
      context.threadId,
      run.id,
    );

    console.log("Initial run status:", runStatus.status);

    while (
      runStatus.status === "running" ||
      runStatus.status === "queued" ||
      runStatus.status === "in_progress"
    ) {
      console.log(
        "Waiting for run to complete, current status:",
        runStatus.status,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(
        context.threadId,
        run.id,
      );
    }

    let responseText = "";

    console.log("Final run status:", runStatus.status);

    // Handle function calls if present
    if (runStatus.status === "requires_action") {
      console.log("Run requires action - handling function calls");
      const toolCalls =
        runStatus.required_action.submit_tool_outputs.tool_calls;
      const toolOutputs = [];

      for (const toolCall of toolCalls) {
        const output = await handleFunctionCall(toolCall);
        toolOutputs.push(output);
      }

      // Submit tool outputs
      await openai.beta.threads.runs.submitToolOutputs(
        context.threadId,
        run.id,
        {
          tool_outputs: toolOutputs,
        },
      );

      // Wait for the run to complete after submitting tool outputs
      runStatus = await openai.beta.threads.runs.retrieve(
        context.threadId,
        run.id,
      );

      while (
        runStatus.status === "running" ||
        runStatus.status === "queued" ||
        runStatus.status === "in_progress"
      ) {
        console.log(
          "Waiting for run to complete after tool outputs, current status:",
          runStatus.status,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        runStatus = await openai.beta.threads.runs.retrieve(
          context.threadId,
          run.id,
        );
      }

      console.log("Final run status after tool outputs:", runStatus.status);
    }

    if (runStatus.status === "completed") {
      // Get the latest messages from the thread
      const messages = await openai.beta.threads.messages.list(
        context.threadId,
      );
      const latestMessage = messages.data[0];

      if (latestMessage.role === "assistant") {
        responseText = latestMessage.content[0].text.value;
      }
    } else {
      console.error("Run failed with status:", runStatus.status);
      if (runStatus.last_error) {
        console.error("Error details:", runStatus.last_error);
      }
      responseText =
        "I'm having trouble processing your request right now. Please try again.";
    }

    console.log("Assistant response:", responseText);

    // Send response via Twilio
    const twilioMessage = await client.messages.create({
      body: responseText,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalizedPhoneNumber,
    });

    // Return success response
    res.json({
      success: true,
      message: responseText,
      messageId: twilioMessage.sid,
    });
  } catch (error) {
    console.error("Error processing message:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Basic webhook for testing
app.post("/webhook-test", (req, res) => {
  console.log("Webhook received:", req.body);
  res.json({ success: true, message: "Webhook received" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

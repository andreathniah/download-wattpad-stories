require("dotenv").config();

const fs = require("fs");
const cors = require("cors");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const firebase = require("firebase");
const Epub = require("epub-gen");
require("firebase/database");

var secretKey = require("./secret.js");

// express configurations
const app = express();
const port = process.env.PORT || 5000;
app.use(cors());

if (process.env.NODE_ENV === "production") {
	// Serve any static files
	app.use(express.static(path.join(__dirname, "client/build")));
	// Handle React routing, return all requests to React app
	app.get("*", function(req, res) {
		res.sendFile(path.join(__dirname, "client/build", "index.html"));
	});
}
app.listen(port, () => console.log(`Listening on port ${port}`));

// firebase configurations
if (!firebase.apps.length) {
	firebase.initializeApp(secretKey.firebaseKey);
}
const db = firebase.database();

app.use(bodyParser.json({ limit: "50mb" }));
app.use(
	bodyParser.urlencoded({
		limit: "50mb",
		extended: true
	})
);

// POST request to extract story from URL
app.post("/", (req, res) => {
	let requestedURL = req.body.url;
	let storyId = req.body.storyId;

	console.log("requestedURL: ", requestedURL);
	promise = startScraping(requestedURL, storyId);
	promise
		.then(key => {
			if (key) deleteProgress(storyId);
		})
		.catch(err => {
			logError(storyId);
			console.log(err);
		});
	res.send({ url: storyId });
});

// POST request to generate PDF from stories
app.post("/pdf", (req, res) => {
	let pdfURL = req.body.url;
	const promise = startPDF(pdfURL);
	promise
		.then(buffer => {
			res.type("application/pdf");
			res.send(buffer);
		})
		.catch(err => console.log(err));
});

// POST request to generate EPUB from stories
app.post("/epub", (req, res) => {
	let epubURL = req.body.url;
	let epubTitle = req.body.title;
	let epubAuthor = req.body.author;
	let epubContent = req.body.content;

	const option = {
		title: epubTitle, // *Required, title of the book.
		author: epubAuthor, // *Required, name of the author.
		content: epubContent
	};

	// replace names with dash as it would be considered as a directory
	const escapedTitle = epubTitle.replace(/[/]/g, "");
	const fileName = `archive/${escapedTitle}.epub`;

	// create directory if not available
	const dir = "./archive";
	if (!fs.existsSync(dir)) fs.mkdirSync(dir);

	const promise = new Promise((resolve, reject) => {
		new Epub(option, fileName).promise
			.then(() => {
				resolve(true);
				console.log("[EPUB] Success => Id: ", epubURL, "\n");
			})
			.catch(err => reject(err));
	});

	promise.then(
		status => {
			const file = __dirname + `/${fileName}`;
			res.download(file, "report.pdf", err => {
				if (!err) {
					// delete local image of .epub after 3 seconds
					setTimeout(() => {
						fs.unlink(fileName, err => {
							if (!err) console.log("Local image deleted");
							else console.log(err);
						});
					}, 3000);
				}
			});
		},
		error => console.log(error)
	);
});

// open new broswer for each PDF request
startPDF = async pdfURL => {
	const pdfBrowser = await puppeteer.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--single-process" // disable this in localhost
		]
	});

	const page = await pdfBrowser.newPage();
	await page.goto(pdfURL);
	await page.waitForSelector(".page"); // wait for react to show contents

	console.log("pdfURL: ", pdfURL);

	const buffer = await page.pdf({
		format: "A4",
		margin: { left: "2cm", top: "2.5cm", right: "2cm", bottom: "2.5cm" }
	});

	console.log("[PDF] Success => Id: ", pdfURL, "\n");

	pdfBrowser.close();
	return buffer;
};

// extract link to the story's summary
extractLink = () => {
	return document
		.querySelector("div.toc-header.text-center")
		.querySelector("a.on-navigate")
		.getAttribute("href");
};

// extract story summary
extractSummary = () => {
	const extractedSummary = document.querySelector("h2.description > pre")
		.innerHTML;

	const text = extractedSummary.replace(/…/g, "...");
	const removedUTF8 = text.replace(/[^\x00-\x7F]/g, "");
	return removedUTF8;
};

// extract story title
extractTitle = () => {
	return document.getElementsByClassName("title h5")[0].innerText;
};

// extract author name
extractAuthor = () => {
	return document.getElementsByClassName("author h6")[0].innerText;
};

// extract the links to all chapters of the story
extractChapters = () => {
	const extractedChapters = document
		.querySelector("ul.table-of-contents")
		.getElementsByTagName("li");

	const chapters = [];
	for (let chapter of extractedChapters) {
		chapters.push(chapter.querySelector("a.on-navigate").getAttribute("href"));
	}
	return chapters;
};

// extract story content and get rid of comments
extractContent = () => {
	$(".comment-marker").remove();
	const extractedElements = document.querySelectorAll("p[data-p-id]");
	const chapterTitle = document.querySelector("header > h2");

	const items = [];
	const title = "<h5>" + chapterTitle.innerHTML + "</h5>";
	items.push("<!--ADD_PAGE-->");
	items.push(title);

	// replace undesired characters outside of ASCII table
	for (let element of extractedElements) {
		const text0 = element.innerHTML.replace(/[…]/g, "...");
		const text1 = text0.replace(/[“]/g, '"');
		const text2 = text1.replace(/[”]/g, '"');
		const text3 = text2.replace(/[’]/g, "'");

		const paragraph = "<p>" + text3 + "</p>";
		items.push(paragraph);
	}
	return items;
};

// scroll wattpad story to the end of the chapter
autoScroll = page => {
	return page.evaluate(() => {
		return new Promise((resolve, reject) => {
			var totalHeight = 0;
			var distance = 100;
			var timer = setInterval(() => {
				var scrollHeight = document.body.scrollHeight;
				window.scrollBy(0, distance);
				totalHeight += distance;

				if (totalHeight >= scrollHeight) {
					clearInterval(timer);
					resolve();
				}
			}, 50);
		});
	});
};

// create gloabl browser on server start to reduce memory usage
(async () => {
	browser = await puppeteer.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage"
		]
	});

	console.log("[ONSTART] Chrome browser started");
})();

// logging error when server receives SIGTERM
process.on("SIGTERM", () => {
	console.log(
		"[ONKILL] Server received kill signal, logging current tickets as failure..."
	);
	const errorRef = db.ref("error");
	const queueRef = db.ref("queue");
	const progressRef = db.ref("progress");

	const toDelete = progressRef.orderByChild("timestamp").limitToLast(1);
	toDelete.on("child_added", snapshot => {
		console.log("[SIGTERM] Cleaning up =>", snapshot.key);
		progressRef.child(snapshot.key).remove();
		errorRef.child(snapshot.key).set({ errorFound: true });
		queueRef.child(snapshot.key).set({ toDelete: true });
	});

	app.close(() => {
		console.log("Ticket disposed, good bye");
		process.exit(0);
	});
});

// choose random common User Agent to avoid detection
getUAString = () => {
	const string0 =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36";
	const string1 =
		"Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36";
	const string2 =
		"Mozilla/5.0 (Windows NT 5.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36";
	const string3 =
		"Mozilla/5.0 (Windows NT 6.2; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36";
	const string4 =
		"Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36";
	const string5 =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/57.0.2987.133 Safari/537.36";
	const string6 =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36";
	const string7 =
		"Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/57.0.2987.133 Safari/537.36";
	const string8 =
		"Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.89 Safari/537.36";
	const UAStrings = [
		string0,
		string1,
		string2,
		string3,
		string4,
		string5,
		string6,
		string7,
		string8
	];
	const randomNo = Math.floor(Math.random() * 8 + 1);

	return UAStrings[randomNo];
};

// create a new page and start scraping materials
startScraping = async (requestedURL, storyId) => {
	const useragent = getUAString();
	console.log("[", storyId, "]", useragent);

	const page = await browser.newPage();
	await page.setUserAgent(useragent);
	await page.setExtraHTTPHeaders({ Referer: "https://www.wattpad.com" });
	await page.goto(requestedURL, { waitUntil: "domcontentloaded" });

	try {
		// grab miscellaneous details
		const storyTitle = await page.evaluate(extractTitle);
		const storyAuthor = await page.evaluate(extractAuthor);
		const chapterURL = await page.evaluate(extractChapters);
		const landingURL = await page.evaluate(extractLink); // find link to summary page
		const story = [];

		// grab every chapter's content
		var count = 0;

		for (let url of chapterURL) {
			const updatedURL = "https://www.wattpad.com" + url;
			await page.setUserAgent(useragent);
			await page.goto(updatedURL, { waitUntil: "domcontentloaded" });

			await autoScroll(page);
			const items = await page.evaluate(extractContent);
			story.push(items);
			console.log("[", storyId, "]", updatedURL);
			updateProgress(storyId, ++count, chapterURL.length);
		}

		// get story's summary content
		const summaryURL = "https://www.wattpad.com" + landingURL;
		await page.setUserAgent(useragent);
		await page.goto(summaryURL, { waitUntil: "domcontentloaded" });
		const storySummary = await page.evaluate(extractSummary);
		console.log("summaryURL: ", summaryURL);

		page.on("error", err => {
			page.goto("about:blank");
			page.close();
			logError(storyId);
			console.log(err);
		});

		const storyKey = saveToFirebase(
			story,
			storyTitle,
			storyAuthor,
			storySummary,
			summaryURL,
			storyId
		);

		await page.goto("about:blank");
		await page.close();
		return storyKey;
	} catch (err) {
		await page.goto("about:blank");
		await page.close();
		logError(storyId);
		console.log(err);
	}
};

// update chapter progress counter of the story
updateProgress = async (storyId, counter, total) => {
	const progressRef = db.ref("progress/" + storyId);
	progressRef.update({ current: counter, total: total, timestamp: Date.now() });
};

// delete progress and flag for error and deletion error occurs
logError = async storyId => {
	const errorRef = db.ref("error/" + storyId);
	const queueRef = db.ref("queue/" + storyId);
	const progressRef = db.ref("progress/" + storyId);

	errorRef.set({ errorFound: true });
	queueRef.set({ toDelete: true });
	progressRef.set({ current: null, total: null, timestamp: null });
	console.log("[ERROR] Closing page =>", storyId);
};

// delete progress and flag for deletion when extraction is completed
deleteProgress = storyId => {
	const progressRef = db.ref("progress/" + storyId);
	const queueRef = db.ref("queue/" + storyId);
	queueRef.set({ toDelete: true });
	progressRef.set({ current: null, total: null, timestamp: null });
};

// commit extracted contents to firebase on on success
let saveToFirebase = (
	story,
	storyTitle,
	storyAuthor,
	storySummary,
	storyURL,
	storyId
) => {
	const storyRef = db.ref("story/" + storyId);
	storyRef.set({
		title: storyTitle,
		author: storyAuthor,
		pages: story,
		summary: storySummary,
		url: storyURL,
		timestamp: Date.now()
	});

	console.log("[STORY] Success => Id: ", storyId, "\n");
	return storyId;
};

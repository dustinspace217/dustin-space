// Eleventy (11ty) configuration file.
// This tells 11ty where source files live, where to put the built output,
// and which files to copy through unchanged (like CSS, JS, and images).

module.exports = function (eleventyConfig) {

	// Pass-through copy: these folders are copied to _site/ exactly as-is.
	// 11ty would otherwise only process template files (njk, html, md, etc.).
	eleventyConfig.addPassthroughCopy("src/assets");

	// Sort a collection of images by date (newest first).
	// Collections are groups of content — here we expose "images" as a
	// sorted list so templates can iterate over them in order.
	eleventyConfig.addCollection("imagesByDate", function (collectionApi) {
		// collectionApi.getAll() returns everything 11ty knows about;
		// we filter to only items that came from the images data file.
		const images = require("./src/_data/images.json");
		// Sort newest first by comparing ISO date strings (lexicographic sort works here).
		return [...images].sort((a, b) => b.date.localeCompare(a.date));
	});

	// A simple filter to format a date string like "2025-11-14" into "November 14, 2025".
	// Filters are called in templates with the pipe syntax: {{ image.date | readableDate }}
	eleventyConfig.addFilter("readableDate", function (dateStr) {
		const date = new Date(dateStr + "T12:00:00Z"); // noon UTC avoids timezone rollover
		return date.toLocaleDateString("en-US", {
			year: "numeric",
			month: "long",
			day: "numeric",
			timeZone: "UTC",
		});
	});

	// A filter to format exposure minutes into a human-readable string.
	// e.g. 380 → "6h 20m"
	eleventyConfig.addFilter("formatExposure", function (minutes) {
		if (!minutes) return "—";
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		if (h === 0) return `${m}m`;
		if (m === 0) return `${h}h`;
		return `${h}h ${m}m`;
	});

	return {
		// Tell 11ty where source files live and where to write built output.
		dir: {
			input: "src",
			output: "_site",
			includes: "_includes",
			data: "_data",
		},
	};
};

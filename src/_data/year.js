// This data file exports the current year so templates can reference it
// as {{ year }} without hardcoding. 11ty runs this at build time.
module.exports = new Date().getFullYear();

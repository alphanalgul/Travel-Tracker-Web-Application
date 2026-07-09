//importing useful packages
import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import session from "express-session";
import flash from "express-flash";
import pg from "pg";
import multer from "multer";
import path from "path";
import bcrypt from "bcrypt";
import fs from "fs";
import axios from "axios";

//configuring .env
dotenv.config();

//configuring the server and port
const app = express();
const port = 3000;

//configuring user session (signed with secret key) and max. time limit for session cookie (24 hours)
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24
  }
}));

//to use flash messages
app.use(flash());

//configuring the database
const db = new pg.Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
});
await db.connect();

//configuring multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {//configuring where files are saved
    cb(null, "public/uploads/");
  },
  filename: (req, file, cb) => {//configuring how files are named (current timestamp in milliseconds + random number between 0 and 10^9 + original extension)
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

//configuring uploads so that only image files are accepted (.png, .jpeg, .webp)
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

app.use(express.static("public")); //makes public accessible for assets, uploads and css
app.use(bodyParser.urlencoded({ extended: true })); //configures body-parser to access user input

//middleware that checks whether the user is logged in or not
function requireLogin(req, res, next) {
  if (!req.session.userId) { // if the user is not logged in, redirect them to the login page
    return res.redirect("/login");
  }

  next();
}

//gets the current logged in user
async function getLoggedInUser(userId) {
  const result = await db.query(
    "SELECT id, username, profile_image, registration_date FROM users WHERE id = $1",
    [userId]
  );
  return result.rows[0];
}

//gets visited/bucket-list countries
async function getCountriesByType(userId, listType) {
  const result = await db.query(
    `
    SELECT country_code
    FROM user_country_lists
    WHERE user_id = $1 AND list_type = $2
    ORDER BY country_code
    `,
    [userId, listType]
  );

  return result.rows.map((row) => row.country_code);
}

//calculates travel statistics (number of countires visited, number of countires in the bucket list, 
// total number of countries in the world and the number of countries lef to visit)
async function getTravelCounts(userId) {
  const visitedResult = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM user_country_lists
     WHERE user_id = $1 AND list_type = 'visited'`,
    [userId]
  );

  const bucketResult = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM user_country_lists
     WHERE user_id = $1 AND list_type = 'bucket'`,
    [userId]
  );

  const countriesVisited = visitedResult.rows[0].count;
  const bucketListCount = bucketResult.rows[0].count;
  const totalCountries = 195;
  const countriesRemaining = totalCountries - countriesVisited;

  return {
    countriesVisited,
    bucketListCount,
    totalCountries,
    countriesRemaining,
  };
}

//to find country code. It searches for the database in the order of 1. exact country code, 2. exact country name 3. partial country name then returns the country name and code
async function findCountryCode(input) {
  const cleanInput = input.trim().toLowerCase();

  const result = await db.query(
    `
    SELECT country_code, country_name
    FROM countries
    WHERE LOWER(country_code) = $1
       OR LOWER(country_name) = $1
       OR LOWER(country_name) LIKE $2
    ORDER BY
      CASE
        WHEN LOWER(country_code) = $1 THEN 1
        WHEN LOWER(country_name) = $1 THEN 2
        WHEN LOWER(country_name) LIKE $2 THEN 3
        ELSE 4
      END,
      LENGTH(country_name),
      country_name
    LIMIT 1
    `,
    [cleanInput, `%${cleanInput}%`]
  );

  return result.rows[0] || null;
}

// Root endpoint (login.ejs)
app.get("/", (req, res) => {
  res.render("login.ejs", {
    msg: req.flash("msg"),
    error: req.flash("error"),
  });
});

// Home page endpoint
app.get("/home", requireLogin, async (req, res) => {
  try {// if the user is logged in, get their details and display a welcoming message
    const user = await getLoggedInUser(req.session.userId);

    res.render("home.ejs", {
      msg: req.flash("msg"),
      user,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// World map endpoint
app.get("/worldmap", requireLogin, async (req, res) => {
  try { //if the user is logged in, display the countries they've already visited in green and their bucket list countries in orange on the world map using their details
    const user = await getLoggedInUser(req.session.userId);
    const visitedCountries = await getCountriesByType(req.session.userId, "visited");
    const bucketCountries = await getCountriesByType(req.session.userId, "bucket");

    res.render("worldmap.ejs", { // render visited countries, bucket-list countries, and their totals
      user,
      visitedCountries,
      bucketCountries,
      visitedTotal: visitedCountries.length,
      bucketTotal: bucketCountries.length,
      msg: req.flash("msg"),
    });
  } catch (err) {
    console.error("Error loading world map:", err);
    res.status(500).send("Server error");
  }
});

// Add country to visited or bucket endpoint 
app.post("/worldmap/add", requireLogin, async (req, res) => {
  //getting user input for country name/id and type (visited or bucket-list)
  const countryInput = req.body.country;
  const listType = req.body.listType;

  if (!countryInput?.trim()) { //if the user didnt enter any country name/id, display an error message
    req.flash("msg", "Please enter a country name.");
    return res.redirect("/worldmap");
  }

  if (!["visited", "bucket"].includes(listType)) { //if the type is not bucket-list or visited, reject the user input
    req.flash("msg", "Invalid list type.");
    return res.redirect("/worldmap");
  }

  try {
    const country = await findCountryCode(countryInput);

    if (!country) { // if the user entered a country that does not exist, display an error message
      req.flash("msg", "Country not found.");
      return res.redirect("/worldmap");
    }

    //prevents a country that is already visited from being moved back to the bucket list
    if (listType === "bucket") {
      const visitedCheck = await db.query(
        `
        SELECT 1
        FROM user_country_lists
        WHERE user_id = $1
          AND country_code = $2
          AND list_type = 'visited'
        `,
        [req.session.userId, country.country_code]
      );

      if (visitedCheck.rows.length > 0) {
        req.flash("msg", "Visited countries cannot be moved back to the bucket list.");
        return res.redirect("/worldmap");
      }
    }

    //delete the country from the opposite list only when adding it to visited
    //this allows bucket-list countries to move to visited, but prevents visited countries from moving back to bucket-list
    if (listType === "visited") {
      await db.query(
        `
        DELETE FROM user_country_lists
        WHERE user_id = $1
          AND country_code = $2
          AND list_type = 'bucket'
        `,
        [req.session.userId, country.country_code]
      );
    }

    //add the country to the visited/bucket list, if it is already there make it visible again
    await db.query(
      `
      INSERT INTO user_country_lists (user_id, country_code, list_type, hide_from_bucketlist)
      VALUES ($1, $2, $3, FALSE)
      ON CONFLICT (user_id, country_code, list_type)
      DO UPDATE SET hide_from_bucketlist = FALSE
      `,
      [req.session.userId, country.country_code, listType]
    );

    //display a success message indicating that the country has been successfully added and re-render the page
    req.flash("msg", `${country.country_name} added to ${listType}.`);
    res.redirect("/worldmap");
  } catch (err) { //if an error occurs while adding the country, display an error message
    console.error("Error adding country:", err);
    req.flash("msg", "Could not add country.");
    res.redirect("/worldmap");
  }
});

// Remove country from visited or bucket endpoint
app.post("/worldmap/remove", requireLogin, async (req, res) => {
  //getting user input for country name/id and type (visited or bucket-list)
  const countryCode = req.body.countryCode;
  const listType = req.body.listType;

  if (!countryCode || !["visited", "bucket"].includes(listType)) { //if the country doesnt exist or is not in visited/bucket-list, display an error message
    req.flash("msg", "Invalid removal request.");
    return res.redirect("/worldmap");
  }

  try {
    await db.query(//remove the country from db
      `
      DELETE FROM user_country_lists
      WHERE user_id = $1 AND country_code = $2 AND list_type = $3
      `,
      [req.session.userId, countryCode, listType]
    );

    //display a success message indicating that the removal operation is completed
    req.flash("msg", `${countryCode} removed from ${listType}.`);
    res.redirect("/worldmap");
  } catch (err) { //if the removal operation cannot be completed , display an error messages
    console.error("Error removing country:", err);
    req.flash("msg", "Could not remove country.");
    res.redirect("/worldmap");
  }
});

//retrieve the names and codes of countries in the bucket-list
async function getBucketCountriesWithNames(userId) {
  const result = await db.query(
    `
    SELECT c.country_code, c.country_name
    FROM user_country_lists ucl
    JOIN countries c ON ucl.country_code = c.country_code
    WHERE ucl.user_id = $1 AND ucl.list_type = 'bucket'
    ORDER BY c.country_name
    `,
    [userId]
  );

  return result.rows;
}

//retrieve bucket list items for all the countries for a user (foods to try out, places to visit, activities to do)
async function getBucketItems(userId) {
  const result = await db.query(
    `
    SELECT id, country_code, section, item_text
    FROM country_bucket_items
    WHERE user_id = $1
    ORDER BY country_code, section, created_at
    `,
    [userId]
  );

  return result.rows;
}

//to get all the visited and bucket-list countries for a user
async function getTrackedCountriesWithNames(userId) {
  const result = await db.query(
    `
    SELECT c.country_code, c.country_name, ucl.list_type
    FROM user_country_lists ucl
    JOIN countries c ON ucl.country_code = c.country_code
    WHERE ucl.user_id = $1
      AND ucl.list_type IN ('bucket', 'visited')
      AND ucl.hide_from_bucketlist = FALSE
    ORDER BY
      CASE
        WHEN ucl.list_type = 'bucket' THEN 1
        WHEN ucl.list_type = 'visited' THEN 2
      END,
      c.country_name
    `,
    [userId]
  );

  return result.rows;
}

//re-formats country names (from official to common) to improve display and to make matching with user input easier
function formatCountryName(countryCode, countryName) {
  const customNames = {
    IR: "Iran",
    SY: "Syria",
    PS: "Palestine",
    FM: "Micronesia",
    TZ: "Tanzania",
    VE: "Venezuela",
    BO: "Bolivia",
    MD: "Moldova",
    RU: "Russia",
    LA: "Laos",
    KP: "North Korea",
    KR: "South Korea",
    VN: "Vietnam",
    TW: "Taiwan",
    BN: "Brunei",
  };

  if (customNames[countryCode]) {
    return customNames[countryCode];
  }

  return countryName
    .replace(/^Republic of /i, "")
    .replace(/^Kingdom of /i, "")
    .replace(/^State of /i, "")
    .replace(/^Islamic Republic of /i, "")
    .replace(/^Syrian Arab Republic$/i, "Syria")
    .replace(/,.*$/, "")
    .trim();
}

//bucket-list endpoint
app.get("/bucketlist", requireLogin, async (req, res) => {
  try {
    //get the countries and activities in the users bucket-list
    const user = await getLoggedInUser(req.session.userId);
    const countries = await getTrackedCountriesWithNames(req.session.userId);
    const bucketItems = await getBucketItems(req.session.userId);

    const groupedCountries = countries.map((country) => {//to display the countries in the users visited/bucket list (an array of bucket-list country objects)
      const places = bucketItems.filter( //to display places to visit
      (item) => item.country_code === country.country_code && item.section === "places"
      );
 
      const food = bucketItems.filter( //to display foods to try out
      (item) => item.country_code === country.country_code && item.section === "food"
      );

      const activities = bucketItems.filter( //to display activities to do
      (item) => item.country_code === country.country_code && item.section === "activities"
      );

      return { //adds country along with its items (places to visit, activities to do, foods to try out) to the array of bucket-list countries
        ...country,
        country_name: formatCountryName(country.country_code, country.country_name),
        places,
        food,
        activities,
      };
  });
    res.render("bucketlist.ejs", {//rendering bucket-list page
      user,
      groupedCountries,
      msg: req.flash("msg"),
    });
  } catch (err) { //if there is an error, display an error message
    console.error("Error loading bucket list page:", err);
    res.status(500).send("Server error");
  }
});

//Endpoint for adding an item to a country in the bucket-list 
//First get all the fields for the bucket-list item from the user input, then check if the user input is valid, if it is add the item and display a success message and if not
//displays an error message and reloads the bucket-list page so that the user can try again
app.post("/bucketlist/add-item", requireLogin, async (req, res) => {
  const { countryCode, section, itemText } = req.body;

  if (!countryCode || !section || !itemText?.trim()) {
    req.flash("msg", "Please fill in all fields.");
    return res.redirect("/bucketlist");
  }

  if (!["places", "food", "activities"].includes(section)) {
    req.flash("msg", "Invalid section.");
    return res.redirect("/bucketlist");
  }

  try {
    await db.query(
      `
      INSERT INTO country_bucket_items (user_id, country_code, section, item_text)
      VALUES ($1, $2, $3, $4)
      `,
      [req.session.userId, countryCode, section, itemText.trim()]
    );

    req.flash("msg", "Item added successfully.");
    res.redirect("/bucketlist");
  } catch (err) {
    console.error("Error adding bucket item:", err);
    req.flash("msg", "Could not add item.");
    res.redirect("/bucketlist");
  }
});

//End point for removing an item from a country in the bucket-list
// User selects an item to be deleted, get its id if it doesnt exist, display an error message, else remove it
app.post("/bucketlist/remove-item", requireLogin, async (req, res) => {
  const { itemId } = req.body;

  if (!itemId) {
    req.flash("msg", "Invalid removal request.");
    return res.redirect("/bucketlist");
  }

  try {
    await db.query(
      `
      DELETE FROM country_bucket_items
      WHERE id = $1 AND user_id = $2
      `,
      [itemId, req.session.userId]
    );

    req.flash("msg", "Item removed successfully.");
    res.redirect("/bucketlist");
  } catch (err) {
    console.error("Error removing bucket item:", err);
    req.flash("msg", "Could not remove item.");
    res.redirect("/bucketlist");
  }
});

//Endpoint for editing an item of a country in the bucket-list
// User selects an item to be edited, get its id if it doesnt exist, display an error message, else update its contents
app.post("/bucketlist/edit-item", requireLogin, async (req, res) => {
  const { itemId, itemText } = req.body;

  if (!itemId || !itemText?.trim()) {
    req.flash("msg", "Invalid edit request.");
    return res.redirect("/bucketlist");
  }

  try {
    await db.query(
      `
      UPDATE country_bucket_items
      SET item_text = $1
      WHERE id = $2 AND user_id = $3
      `,
      [itemText.trim(), itemId, req.session.userId]
    );

    req.flash("msg", "Item updated successfully.");
    res.redirect("/bucketlist");
  } catch (err) {
    console.error("Error editing bucket item:", err);
    req.flash("msg", "Could not update item.");
    res.redirect("/bucketlist");
  }
});

//Endpoint for hiding a visited country from the bucket-list page and deleting its bucket-list items
app.post("/bucketlist/remove-country-items", requireLogin, async (req, res) => {
  const { countryCode } = req.body;

  if (!countryCode) {
    req.flash("msg", "Invalid country removal request.");
    return res.redirect("/bucketlist");
  }

  try {
    //checks if the country is in the user's visited list and gets its name
    const countryResult = await db.query(
      `
      SELECT c.country_name
      FROM user_country_lists ucl
      JOIN countries c ON ucl.country_code = c.country_code
      WHERE ucl.user_id = $1
        AND ucl.country_code = $2
        AND ucl.list_type = 'visited'
      `,
      [req.session.userId, countryCode]
    );

    if (countryResult.rows.length === 0) {
      req.flash("msg", "Only visited countries can be removed here.");
      return res.redirect("/bucketlist");
    }

    const countryName = formatCountryName(
      countryCode,
      countryResult.rows[0].country_name
    );

    //deletes all bucket-list items for this visited country
    await db.query(
      `
      DELETE FROM country_bucket_items
      WHERE user_id = $1
        AND country_code = $2
      `,
      [req.session.userId, countryCode]
    );

    //hides this visited country from the bucket-list page
    await db.query(
      `
      UPDATE user_country_lists
      SET hide_from_bucketlist = TRUE
      WHERE user_id = $1
        AND country_code = $2
        AND list_type = 'visited'
      `,
      [req.session.userId, countryCode]
    );

    req.flash("msg", `${countryName} removed from bucket list page.`);
    res.redirect("/bucketlist");
  } catch (err) {
    console.error("Error removing visited country items:", err);
    req.flash("msg", "Could not remove country.");
    res.redirect("/bucketlist");
  }
});

//to display explorer levels based on how many countries the user has visited
function getExplorerLevel(countriesVisited) {
    const levels = [
    { min: 0, name: "Novice Traveler" },
    { min: 5, name: "Curious Wanderer" },
    { min: 10, name: "Rising Explorer" },
    { min: 25, name: "Marco Polo" },
    { min: 50, name: "Zheng He" },
    { min: 75, name: "Ferdinand Magellan" },
    { min: 100, name: "Amerigo Vespucci" },
    { min: 150, name: "Ibn Battuta" },
    { min: 195, name: "World Conqueror" }
    ];

  let currentLevel = levels[0];
  let nextLevel = null;

  for (let i = 0; i < levels.length; i++) {
    if (countriesVisited >= levels[i].min) {
      currentLevel = levels[i];
      nextLevel = levels[i + 1] || null;
    }
  }

  return {
    currentLevel: currentLevel.name,
    nextMilestone: nextLevel ? nextLevel.min : null,
    countriesToNext: nextLevel ? nextLevel.min - countriesVisited : 0,
    milestoneProgress: nextLevel
      ? (countriesVisited / nextLevel.min) * 100
      : 100,
  };
}

//counts the total number of countries
const totalCountriesResult = await db.query(
  `
  SELECT COUNT(*)::int AS count
  FROM countries
  WHERE counts_in_stats = TRUE
  `
);

const totalCountries = totalCountriesResult.rows[0].count;

//returns continent travel statistics for the user (how many continents visited, percentage of the continent visited, least visited continent, most visited continent)
async function getContinentStats(userId) {
  const result = await db.query(// counts how many countries the user has visitied in a continent
    `
    SELECT c.continent, COUNT(*)::int AS visited_count
    FROM user_country_lists ucl
    JOIN countries c ON ucl.country_code = c.country_code
    WHERE ucl.user_id = $1
      AND ucl.list_type = 'visited'
      AND c.counts_in_stats = TRUE
    GROUP BY c.continent
    `,
    [userId]
  );

  const continentTotalsResult = await db.query( // counts the total number of countries in a continent
    `
    SELECT continent, COUNT(*)::int AS total
    FROM countries
    WHERE counts_in_stats = TRUE
    GROUP BY continent
    `
  );

  const continentTotals = {};//stores total number of countries per continent
  continentTotalsResult.rows.forEach((row) => {
    continentTotals[row.continent] = row.total;
  });

  //stores number of countries the user has visited per continent
  const visitedByContinent = {};
  Object.keys(continentTotals).forEach((continent) => {
    visitedByContinent[continent] = 0;
  });
  result.rows.forEach((row) => {
    visitedByContinent[row.continent] = row.visited_count;
  });

  //calculates the percentage of countries that the user has visited per continent
  const continentBreakdown = Object.entries(continentTotals).map(
    ([continent, total]) => {
      const visited = visitedByContinent[continent] || 0;

      let percent;

      if (total > 0) {
        percent = Math.round((visited / total) * 100);
      } else {
        percent = 0;
      }

      return {
        name: continent,
        visited,
        total,
        percent,
      };
    }
  );

  //calculates the number of continents that the user has visited 
  const continentsVisited = continentBreakdown.filter((c) => {
    return c.visited > 0;
  }).length;

  //finds the most visited continent for the user
  const mostVisited = continentBreakdown.reduce((max, current) => {
    if (current.visited > max.visited) {
      return current;
    } else {
      return max;
    }
  });

  //finds the least visited continent for the user
  const leastVisited = continentBreakdown.reduce((min, current) => {
    if (current.visited < min.visited) {
      return current;
    } else {
      return min;
    }
  });

  return {
    continentBreakdown,
    continentsVisited,
    mostVisited,
    leastVisited,
  };
}

//calculate travel stats (countries visited, number of countries in the bucket list, total countries, countries remaining, level info, continent stats, world progress)
async function getTravelStats(userId) {
  const visitedResult = await db.query(
    `
    SELECT COUNT(*)::int AS count
    FROM user_country_lists
    WHERE user_id = $1 AND list_type = 'visited'
    `,
    [userId]
  );

  const bucketResult = await db.query(
    `
    SELECT COUNT(*)::int AS count
    FROM user_country_lists
    WHERE user_id = $1 AND list_type = 'bucket'
    `,
    [userId]
  );

  const countriesVisited = visitedResult.rows[0].count;
  const bucketListCount = bucketResult.rows[0].count;
  const totalCountries = 195;
  const countriesRemaining = totalCountries - countriesVisited;
  const worldProgress = Math.round((countriesVisited / totalCountries) * 100);

  const levelInfo = getExplorerLevel(countriesVisited);
  const continentStats = await getContinentStats(userId);

  return {
    countriesVisited,
    bucketListCount,
    totalCountries,
    countriesRemaining,
    worldProgress,
    ...levelInfo,
    ...continentStats,
  };
}

//end point for travel stats for the user
app.get("/travelstats", requireLogin, async (req, res) => {
  try {
    const user = await getLoggedInUser(req.session.userId);
    const stats = await getTravelStats(req.session.userId);

    res.render("travelstats.ejs", {
      user,
      stats,
    });
  } catch (err) {
    console.error("Error loading travel stats:", err);
    res.status(500).send("Server error");
  }
});

// Endpoint for user profile
app.get("/profile", requireLogin, async (req, res) => {
  try {
    const user = await getLoggedInUser(req.session.userId);
    if (!user) {
      return res.status(404).send("User not found");
    }

  const stats = await getTravelStats(req.session.userId); //displaying travel stats on the users profile

  res.render("profile.ejs", {
    user,
    stats,
  });
  } catch (err) {
    console.error("Error loading profile:", err);
    res.status(500).send("Server error");
  }
});

//returns the list of visited countries for the user
async function getVisitedCountries(userId) {
  const result = await db.query(
    `
    SELECT c.country_code, c.country_name
    FROM user_country_lists ucl
    JOIN countries c ON c.country_code = ucl.country_code
    WHERE ucl.user_id = $1
      AND ucl.list_type = 'visited'
    ORDER BY c.country_name ASC
    `,
    [userId]
  );

  return result.rows;
}
//search, find and return the gallery sections for a country
async function getGallerySectionsByCountry(userId, countryCode) {
  const sectionsResult = await db.query(
    `
    SELECT *
    FROM gallery_sections
    WHERE user_id = $1
      AND country_code = $2
    ORDER BY created_at DESC
    `,
    [userId, countryCode]
  );

  const sections = sectionsResult.rows;

  for (const section of sections) {
    const photosResult = await db.query(
      `
      SELECT *
      FROM gallery_photos
      WHERE section_id = $1
      ORDER BY created_at DESC
      `,
      [section.id]
    );

    section.photos = photosResult.rows;
  }

  return sections;
}

//Endpoint for photo gallery 
//Displays the list of visited countries, then the user can click any of them to view their photo gallery sections for that country
app.get("/gallery", requireLogin, async (req, res) => {
  try {
    const user = await getLoggedInUser(req.session.userId);
    const visitedCountries = await getVisitedCountries(req.session.userId);

    let selectedCountryCode = req.query.country;

    if (!selectedCountryCode && visitedCountries.length > 0) {
      selectedCountryCode = visitedCountries[0].country_code;
    }

    let gallerySections = [];
    let selectedCountry = null;

    if (selectedCountryCode) {
      gallerySections = await getGallerySectionsByCountry(
        req.session.userId,
        selectedCountryCode
      );

      selectedCountry = visitedCountries.find(
        (country) => country.country_code === selectedCountryCode
      );
    }

    res.render("gallery.ejs", {
      user,
      visitedCountries,
      selectedCountryCode,
      selectedCountry,
      gallerySections,
      success: req.flash("success"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading gallery page.");
  }
});

//Endpoint for creating a new gallery section for the selected visited country
app.post("/gallery/section", requireLogin, async (req, res) => {
  const { country_code, title, description } = req.body;

  try {
    const visitedCheck = await db.query(
      `
      SELECT 1
      FROM user_country_lists
      WHERE user_id = $1
        AND country_code = $2
        AND list_type = 'visited'
      `,
      [req.session.userId, country_code]
    );

    if (visitedCheck.rows.length === 0) {
      req.flash("error", "You can only create gallery sections for visited countries.");
      return res.redirect("/gallery");
    }

    await db.query(//saving the new section to the db
      `
      INSERT INTO gallery_sections (user_id, country_code, title, description)
      VALUES ($1, $2, $3, $4)
      `,
      [req.session.userId, country_code, title, description]
    );

    req.flash("success", "Gallery section created successfully.");
    res.redirect(`/gallery?country=${country_code}`); //redirects the user to the country gallery
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to create gallery section.");
    res.redirect("/gallery");
  }
});

//Enpoint for uploading a new photo to the photo gallery
app.post("/gallery/photo", requireLogin, upload.single("photo"), async (req, res) => {
  const { section_id, country_code, caption } = req.body;

  try {
    const sectionCheck = await db.query(
      `
      SELECT *
      FROM gallery_sections
      WHERE id = $1
        AND user_id = $2
      `,
      [section_id, req.session.userId]
    );

    if (sectionCheck.rows.length === 0) {
      req.flash("error", "Section not found.");
      return res.redirect("/gallery");
    }

    if (!req.file) {
      req.flash("error", "Please choose a photo to upload.");
      return res.redirect(`/gallery?country=${country_code}`); //redirects the user to the country gallery
    }

    await db.query(//saving the photo details (image_path, caption, section id) to the db
      `
      INSERT INTO gallery_photos (section_id, image_path, caption)
      VALUES ($1, $2, $3)
      `,
      [section_id, `/uploads/${req.file.filename}`, caption || null]
    );

    req.flash("success", "Photo uploaded successfully.");
    res.redirect(`/gallery?country=${country_code}`);
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to upload photo.");
    res.redirect("/gallery");
  }
});

//Endpoint for deleting a gallery section
app.post("/gallery/section/:id/delete", requireLogin, async (req, res) => {
  const { country_code } = req.body;
  const sectionId = req.params.id;

  try {
    await db.query(//deleting the gallery section from db
      `
      DELETE FROM gallery_sections
      WHERE id = $1
        AND user_id = $2
      `,
      [sectionId, req.session.userId]
    );

    req.flash("success", "Section deleted successfully.");
    res.redirect(`/gallery?country=${country_code}`);//redirects the user to the country gallery
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to delete section.");
    res.redirect(`/gallery?country=${country_code}`);
  }
});

//Endpoint for deleting a photo from gallery
app.post("/gallery/photo/:id/delete", requireLogin, async (req, res) => {
  const { country_code } = req.body;
  const photoId = req.params.id;

  try {
    await db.query(//deleting the photo record from db
      `
      DELETE FROM gallery_photos
      WHERE id = $1
        AND section_id IN (
          SELECT id FROM gallery_sections WHERE user_id = $2
        )
      `,
      [photoId, req.session.userId]
    );

    req.flash("success", "Photo deleted successfully.");
    res.redirect(`/gallery?country=${country_code}`);//redirects the user to the country gallery
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to delete photo.");
    res.redirect(`/gallery?country=${country_code}`);
  }
});

//Endpoint for downloading an image from the gallery
app.get("/gallery/photo/:id/download", requireLogin, async (req, res) => {
  const photoId = req.params.id;

  try {
    const result = await db.query(
      `
      SELECT gp.image_path
      FROM gallery_photos gp
      JOIN gallery_sections gs ON gp.section_id = gs.id
      WHERE gp.id = $1
        AND gs.user_id = $2
      `,
      [photoId, req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Photo not found");
    }

    const filePath = "public" + result.rows[0].image_path;//retrieve image path from db

    res.download(filePath);//starts the download
  } catch (err) {
    console.error(err);
    res.status(500).send("Download failed");
  }
});


// Registration endpoint
app.get("/registration", (req, res) => {
  res.render("registration.ejs", {
    msg: req.flash("msg"),
  });
});
// Login endpoint
app.get("/login", (req, res) => {
  res.render("login.ejs", {
    msg: req.flash("msg"),
    error: req.flash("error"),
  });
});

//Registration logic
app.post("/submit", upload.single("profileImage"), async (req, res) => {
  //retrieve user username, password and profile image
  const username = req.body.username;
  const pwd = req.body.password;
  const profileImage = req.file;

  try {
    if (!username?.trim() || !pwd?.trim()) { //if the user didnt enter usernam/password, display an error message
      return res.render("registration.ejs", {
        msg: "Please fill in all required fields!",
      });
    }

    if (!profileImage) { // if the user didnt upload a profile picture, display an error message
      return res.render("registration.ejs", {
        msg: "Please choose a profile picture!",
      });
    }

    const existingUser = await db.query( //check whether the username is already taken or not
      "SELECT username FROM users WHERE username = $1",
      [username]
    );

    if (existingUser.rows.length > 0) { // if it is already taken, display an error mesage
      return res.render("registration.ejs", {
        msg: "This username is already taken!",
      });
    }

    if (pwd.length < 8) { // password should be at least 8 characters long, if it is not, display an error message.
      return res.render("registration.ejs", {
        msg: "Your password is too short! It should be at least 8 characters long",
      });
    }

    if (!/[0-9]/.test(pwd)) { //the password should contain at least one number
      return res.render("registration.ejs", {
        msg: "Invalid Password! Your password should contain at least 1 number",
      });
    }

    if (!/[A-Z]/.test(pwd)) {  //the password should contain at least one uppercase letter
      return res.render("registration.ejs", {
        msg: "Invalid Password! Your password should contain at least 1 uppercase letter",
      });
    }

    if (!/[a-z]/.test(pwd)) {  //the password should contain at least one lowercase letter
      return res.render("registration.ejs", {
        msg: "Invalid Password! Your password should contain at least 1 lowercase letter",
      });
    }

    if (!/[!#$%&|*+_\/?~.;:'^@€₺]/.test(pwd)) {  //the password should contain at least one special character
      return res.render("registration.ejs", {
        msg: "Invalid Password! Your password should contain at least 1 special character",
      });
    }

    //get the image path and hash the user password using bcrypt with 10 salt rounds
    const imagePath = "/uploads/" + profileImage.filename;
    const hashedPassword = await bcrypt.hash(pwd, 10);

    //create the user account and save its details to the database
    await db.query(
      "INSERT INTO users(username, password, profile_image) VALUES ($1, $2, $3)",
      [username, hashedPassword, imagePath]
    );

    //display a message based on success or failure

    req.flash("msg", "Registration Successful");
    return res.redirect("/login");
  } catch (err) {
    console.error(err);
    return res.render("registration.ejs", {
      msg: "Something went wrong during registration!",
    });
  }
});

// Login submit
app.post("/login", async (req, res) => {
  //retrieve user username and password
  const login_username = req.body.username;
  const login_pwd = req.body.password;

  try {
    const result = await db.query(//ssearch db for username
      "SELECT * FROM users WHERE username = $1",
      [login_username]
    );

    if (result.rows.length === 0) { //if there is no match (user not found), display an error message
      return res.render("login.ejs", {
            msg: [],
            error: ["Invalid Username or Password!"],
      });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(login_pwd, user.password);

    //compare user password with the hashed password stored in db
    if (!passwordMatch) {
      return res.render("login.ejs", {
        msg: [],
        error: ["Invalid Username or Password!"],
      });
    }

    //Display success/error message based on outcome
    req.session.userId = user.id;
    req.flash("msg", `Login Successful! Welcome, ${login_username}!`);
    return res.redirect("/home");
  } catch (err) {
    console.error(err);
    return res.render("login.ejs", {
        msg: [],
        error: ["Login failed. Please try again."],
    });
  }
});

//function to convert messy geoapify output into readable object
function formatGeoapifyPlace(feature) {
  const p = feature.properties || {};//stores properties object returned by geoapify feature

  //retrieve place name from geoapify data (use address as fallback)
  let name = "Unnamed place";
  if (p.name) {
    name = p.name;
  } else if (p.address_line1) {
    name = p.address_line1;
  }

  //retrieve address from geoapify data (use address_line2 as fallback)
  let address = "Address not available";
  if (p.formatted) {
    address = p.formatted;
  } else if (p.address_line2) {
    address = p.address_line2;
  }

  //retrieve distance from geoapify data and convert it to km (geoapify calculates it as m)
  let distance = null;
  if (p.distance) {
    distance = `${(p.distance / 1000).toFixed(1)} km away`;
  }

  //creates a google maps link with latitude and longtitude data from geoapify
  let mapsUrl = null;
  if (p.lat && p.lon) {
    mapsUrl = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
  }

  return {//returning a readable geoapify data object
    name: name,
    address: address,
    lat: p.lat,
    lon: p.lon,
    distance: distance,
    mapsUrl: mapsUrl,
  };
}

//retrieve user destination data, use axios to send data to geoapify api and get location coordinates as result
async function geocodeDestination(searchText) {
  const response = await axios.get(
    "https://api.geoapify.com/v1/geocode/search",
    {
      params: {
        text: searchText,
        format: "json",
        limit: 1,
        apiKey: process.env.GEOAPIFY_API_KEY,
      },
    }
  );

  const result = response.data.results[0];

  if (!result) {
    return null;
  }

  return {
    lat: result.lat,
    lon: result.lon,
    formatted: result.formatted,
  };
}

//uses geoapify to find 10 locations within a 15km radius
async function getGeoapifyPlaces(categories, lon, lat, radius) {
  if (!radius) {
    radius = 15000;
  }

  const response = await axios.get("https://api.geoapify.com/v2/places", {
    params: {
      categories: categories,
      filter: `circle:${lon},${lat},${radius}`,
      bias: `proximity:${lon},${lat}`,
      limit: 10,
      apiKey: process.env.GEOAPIFY_API_KEY,
    },
  });

  const places = response.data.features.map(function (feature) {
    return formatGeoapifyPlace(feature);
  });

  return places;
}

//Endpoint for the travel planner pages
app.get("/bucketlist/:countryCode/travel", requireLogin, async (req, res) => {
  const countryCode = req.params.countryCode; //retrieve country code

  let city = "";
  if (req.query.city) { //retrieve city data from the user
    city = req.query.city.trim();
  }

  try {//check if the country is in visited/bucket list
    const countryResult = await db.query(
      `
      SELECT c.country_code, c.country_name
      FROM user_country_lists ucl
      JOIN countries c ON ucl.country_code = c.country_code
      WHERE ucl.user_id = $1
        AND ucl.country_code = $2
        AND ucl.list_type IN ('bucket', 'visited')
        AND ucl.hide_from_bucketlist = FALSE
      LIMIT 1
      `,
      [req.session.userId, countryCode]
    );

    if (countryResult.rows.length === 0) { //if not, display error message
      req.flash("msg", "This country is not available for travel planning.");
      return res.redirect("/bucketlist");
    }

    //format country name
    const country = countryResult.rows[0];
    const displayCountryName = formatCountryName(
      country.country_code,
      country.country_name
    );

    if (!city) {//if the user didnt enter any city, return with empty results
      return res.render("travel-planner.ejs", {
        countryCode: countryCode,
        countryName: displayCountryName,
        city: "",
        locationName: null,
        hotels: [],
        transport: [],
        attractions: [],
        error: null,
      });
    }

    let searchText = city + ", " + displayCountryName; //if the user enters a city, convert it to geoapify search text (for example, Samsun, Turkey)

    const location = await geocodeDestination(searchText);

    if (!location) { //if the city cannot be found, display an error message
      return res.render("travel-planner.ejs", {
        countryCode: countryCode,
        countryName: displayCountryName,
        city: city,
        locationName: null,
        hotels: [],
        transport: [],
        attractions: [],
        error: "Could not find this destination.",
      });
    }

    const hotels = await getGeoapifyPlaces(//find hotels within a 15km radius
      "accommodation.hotel,accommodation.hostel,accommodation.guest_house",
      location.lon,
      location.lat,
      15000
    );

    const transport = await getGeoapifyPlaces(//find transportation options within 15km radius
      "airport,public_transport.train,public_transport.bus,public_transport.subway",
      location.lon,
      location.lat,
      15000
    );

    const attractions = await getGeoapifyPlaces(//find tourist attractions within a 15km radius
      "tourism.attraction,tourism.sights",
      location.lon,
      location.lat,
      15000
    );

    res.render("travel-planner.ejs", { //render travel-planner page
      countryCode: countryCode,
      countryName: displayCountryName,
      city: city,
      locationName: location.formatted,
      hotels: hotels,
      transport: transport,
      attractions: attractions,
      error: null,
    });
  } catch (err) {
    let errorMessage = err.message;

    if (err.response && err.response.data) {
      errorMessage = err.response.data;
    }

    console.error("Travel planner error:", errorMessage);

    res.render("travel-planner.ejs", {//if there is an error, display an error message and render the page with empty results
      countryCode: countryCode,
      countryName: countryCode,
      city: city,
      locationName: null,
      hotels: [],
      transport: [],
      attractions: [],
      error: "Travel data could not be loaded.",
    });
  }
});

//to check whether the app is running or not
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
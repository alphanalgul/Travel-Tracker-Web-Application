
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    profile_image TEXT,
    registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE countries(
    id SERIAL PRIMARY KEY,
    country_code CHAR(2),
    countr_name VARCHAR(100)
);

CREATE TABLE user_country_lists (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    country_code CHAR(2),
    list_type VARCHAR(10)
);

CREATE TABLE gallery_sections (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    country_code VARCHAR(2) NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gallery_photos (
    id SERIAL PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES gallery_sections(id) ON DELETE CASCADE,
    image_path TEXT NOT NULL,
    caption VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
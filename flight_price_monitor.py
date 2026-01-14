import requests
import sqlite3
import schedule
import time
from datetime import datetime
import smtplib
from email.mime.text import MIMEText
from dotenv import load_dotenv
import os

# ----------------------------
# LOAD ENVIRONMENT VARIABLES
# ----------------------------

load_dotenv()

AMADEUS_API_KEY = os.getenv("MZPEEVFyWD2kM4CG7LY0YI8dGFYjU9p3")
AMADEUS_API_SECRET = os.getenv("zqJ78pJKTxg74GCN")
EMAIL_PASSWORD = os.getenv("fpkd oaaw euwh huxn")

# ----------------------------
# CONFIGURATION
# ----------------------------

ORIGIN = "SYD"
DESTINATION = "LAX"
DEPARTURE_DATE = "2026-03-10"
FLIGHT_NUMBER = "QF11"

MAX_PRICE_ALERT = 1200.00
MIN_SEATS_ALERT = 3

CHECK_INTERVAL_MINUTES = 60

EMAIL_FROM = "your_email@gmail.com"
EMAIL_TO = "your_email@gmail.com"

DB_FILE = "prices.db"

# ----------------------------
# DATABASE SETUP
# ----------------------------

def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS flight_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            checked_at TEXT,
            flight_number TEXT,
            price REAL,
            seats_left INTEGER,
            currency TEXT
        )
    """)

    conn.commit()
    conn.close()

# ----------------------------
# AUTHENTICATION
# ----------------------------

def get_access_token():
    url = "https://test.api.amadeus.com/v1/security/oauth2/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": AMADEUS_API_KEY,
        "client_secret": AMADEUS_API_SECRET
    }

    response = requests.post(url, data=data)
    response.raise_for_status()
    return response.json()["access_token"]

# ----------------------------
# FETCH FLIGHT PRICE + SEATS
# ----------------------------

def fetch_flight_data():
    token = get_access_token()

    url = "https://test.api.amadeus.com/v2/shopping/flight-offers"
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "originLocationCode": ORIGIN,
        "destinationLocationCode": DESTINATION,
        "departureDate": DEPARTURE_DATE,
        "adults": 1,
        "currencyCode": "AUD",
        "max": 10
    }

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()

    offers = response.json()["data"]

    for offer in offers:
        segment = offer["itineraries"][0]["segments"][0]
        flight_no = f"{segment['carrierCode']}{segment['number']}"

        if flight_no == FLIGHT_NUMBER:
            price = float(offer["price"]["total"])
            seats = offer.get("numberOfBookableSeats", 0)
            currency = offer["price"]["currency"]
            return price, seats, currency

    raise Exception("Specified flight not found")

# ----------------------------
# STORE DATA
# ----------------------------

def store_data(price, seats, currency):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute("""
        INSERT INTO flight_prices
        (checked_at, flight_number, price, seats_left, currency)
        VALUES (?, ?, ?, ?, ?)
    """, (
        datetime.utcnow().isoformat(),
        FLIGHT_NUMBER,
        price,
        seats,
        currency
    ))

    conn.commit()
    conn.close()

# ----------------------------
# ALERTING
# ----------------------------

def send_email_alert(price, seats):
    body = f"""
Flight Alert Triggered

Flight: {FLIGHT_NUMBER}
Route: {ORIGIN} → {DESTINATION}
Date: {DEPARTURE_DATE}

Price: {price} AUD
Seats Remaining at this fare: {seats}

Alert Conditions:
- Price ≤ {MAX_PRICE_ALERT}
- Seats ≤ {MIN_SEATS_ALERT}
"""

    msg = MIMEText(body)
    msg["Subject"] = "✈️ Flight Price / Seat Alert"
    msg["From"] = EMAIL_FROM
    msg["To"] = EMAIL_TO

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(EMAIL_FROM, EMAIL_PASSWORD)
        server.send_message(msg)

# ----------------------------
# CHECK LOGIC
# ----------------------------

def check_flight():
    try:
        price, seats, currency = fetch_flight_data()
        store_data(price, seats, currency)

        print(f"[{datetime.now()}] {FLIGHT_NUMBER} | {price} {currency} | Seats: {seats}")

        if price <= MAX_PRICE_ALERT or seats <= MIN_SEATS_ALERT:
            send_email_alert(price, seats)
            print("ALERT SENT")

    except Exception as e:
        print(f"ERROR: {e}")

# ----------------------------
# SCHEDULER
# ----------------------------

def main():
    init_db()
    check_flight()
    schedule.every(CHECK_INTERVAL_MINUTES).minutes.do(check_flight)

    while True:
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    main()

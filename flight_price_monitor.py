import requests
import sqlite3
from datetime import datetime
import smtplib
from email.mime.text import MIMEText
from dotenv import load_dotenv
import os

# ----------------------------
# LOAD ENVIRONMENT VARIABLES
# ----------------------------
load_dotenv()

AMADEUS_API_KEY = os.getenv("AMADEUS_API_KEY")
AMADEUS_API_SECRET = os.getenv("AMADEUS_API_SECRET")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD")
EMAIL_FROM = os.getenv("EMAIL_FROM") or "your_email@gmail.com"
EMAIL_TO = os.getenv("EMAIL_TO") or "your_email@gmail.com"

# ----------------------------
# CONFIGURATION
# ----------------------------
ORIGIN = "SIN"
DESTINATION = "MEL"
DEPARTURE_DATE = "2026-02-16"
FLIGHT_NUMBER = "TK168"

MAX_PRICE_ALERT = 1200.00
MIN_SEATS_ALERT = 2

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
            currency TEXT,
            fare_class TEXT,
            aircraft TEXT,
            cabin TEXT,
            departure_time TEXT,
            arrival_time TEXT,
            flight_duration TEXT
        )
    """)
    conn.commit()
    conn.close()

# ----------------------------
# AUTHENTICATION
# ----------------------------
def get_access_token():
    url = "https://test.api.amadeus.com/v1/security/oauth2/token"
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    data = {
        "grant_type": "client_credentials",
        "client_id": AMADEUS_API_KEY,
        "client_secret": AMADEUS_API_SECRET
    }
    response = requests.post(url, headers=headers, data=data)
    response.raise_for_status()
    return response.json()["access_token"]

# ----------------------------
# FETCH FLIGHT DATA
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
            fare_class = segment.get("pricingDetailPerAdult", {}).get("fareClass", "N/A")
            aircraft = segment.get("aircraft", {}).get("code", "N/A")
            cabin = segment.get("cabin", "N/A")
            departure_time = segment["departure"]["at"]
            arrival_time = segment["arrival"]["at"]
            flight_duration = segment.get("duration", "N/A")
            return {
                "price": price,
                "seats": seats,
                "currency": currency,
                "fare_class": fare_class,
                "aircraft": aircraft,
                "cabin": cabin,
                "departure_time": departure_time,
                "arrival_time": arrival_time,
                "flight_duration": flight_duration
            }

    raise Exception("Specified flight not found")

# ----------------------------
# STORE DATA
# ----------------------------
def store_data(flight_info):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO flight_prices
        (checked_at, flight_number, price, seats_left, currency, fare_class, aircraft, cabin, departure_time, arrival_time, flight_duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        datetime.utcnow().isoformat(),
        FLIGHT_NUMBER,
        flight_info["price"],
        flight_info["seats"],
        flight_info["currency"],
        flight_info["fare_class"],
        flight_info["aircraft"],
        flight_info["cabin"],
        flight_info["departure_time"],
        flight_info["arrival_time"],
        flight_info["flight_duration"]
    ))
    conn.commit()
    conn.close()

# ----------------------------
# EMAIL ALERT
# ----------------------------
def send_email_alert(flight_info):
    body = f"""
Flight Alert Triggered

Flight: {FLIGHT_NUMBER}
Route: {ORIGIN} → {DESTINATION}
Date: {DEPARTURE_DATE}

Price: {flight_info['price']} {flight_info['currency']}
Seats Remaining at this fare: {flight_info['seats']}
Fare Class: {flight_info['fare_class']}
Aircraft: {flight_info['aircraft']}
Cabin: {flight_info['cabin']}
Departure: {flight_info['departure_time']}
Arrival: {flight_info['arrival_time']}
Duration: {flight_info['flight_duration']}

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
# CHECK FLIGHT
# ----------------------------
def check_flight():
    try:
        flight_info = fetch_flight_data()
        store_data(flight_info)

        # Print to GitHub Actions log
        print(f"[{datetime.now()}] {FLIGHT_NUMBER} | Price: {flight_info['price']} {flight_info['currency']} | Seats: {flight_info['seats']}")
        print(f"Fare Class: {flight_info['fare_class']} | Aircraft: {flight_info['aircraft']} | Cabin: {flight_info['cabin']}")
        print(f"Departure: {flight_info['departure_time']} | Arrival: {flight_info['arrival_time']} | Duration: {flight_info['flight_duration']}")

        # Send email alert if conditions met
        if flight_info["price"] <= MAX_PRICE_ALERT or flight_info["seats"] <= MIN_SEATS_ALERT:
            send_email_alert(flight_info)
            print("ALERT SENT")

    except Exception as e:
        print(f"ERROR: {e}")

# ----------------------------
# MAIN EXECUTION
# ----------------------------
if __name__ == "__main__":
    init_db()
    check_flight()

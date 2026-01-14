import requests
import sqlite3
from datetime import datetime
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
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
TARGET_FLIGHT_NUMBER = "TH168"  # Fixed typo from THY168

MAX_PRICE_ALERT = 1200.00
MIN_SEATS_ALERT = 3

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
# FETCH ALL FLIGHTS DATA
# ----------------------------
def fetch_all_flights():
    token = get_access_token()
    url = "https://test.api.amadeus.com/v2/shopping/flight-offers"
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "originLocationCode": ORIGIN,
        "destinationLocationCode": DESTINATION,
        "departureDate": DEPARTURE_DATE,
        "adults": 1,
        "currencyCode": "AUD",
        "max": 250,  # Increased to get more results
        "nonStop": "false"  # Include connecting flights
    }

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    offers = response.json()["data"]

    flights_data = []
    seen_flights = set()  # Track unique flight numbers to avoid duplicates

    for offer in offers:
        # Get first segment (outbound flight)
        segment = offer["itineraries"][0]["segments"][0]
        flight_no = f"{segment['carrierCode']}{segment['number']}"
        
        # Skip if we've already processed this flight number
        if flight_no in seen_flights:
            continue
        seen_flights.add(flight_no)

        price = float(offer["price"]["total"])
        seats = offer.get("numberOfBookableSeats", 0)
        currency = offer["price"]["currency"]
        
        # Extract additional details safely
        fare_class = "N/A"
        if "travelerPricings" in offer and len(offer["travelerPricings"]) > 0:
            fare_details = offer["travelerPricings"][0].get("fareDetailsBySegment", [])
            if fare_details:
                fare_class = fare_details[0].get("class", "N/A")
        
        aircraft = segment.get("aircraft", {}).get("code", "N/A")
        cabin = segment.get("cabin", "N/A")
        departure_time = segment["departure"]["at"]
        arrival_time = segment["arrival"]["at"]
        
        # Get the total duration for the itinerary
        flight_duration = offer["itineraries"][0].get("duration", "N/A")
        
        # Check if it's a direct flight or has stops
        num_stops = len(offer["itineraries"][0]["segments"]) - 1
        
        flights_data.append({
            "flight_number": flight_no,
            "price": price,
            "seats": seats,
            "currency": currency,
            "fare_class": fare_class,
            "aircraft": aircraft,
            "cabin": cabin,
            "departure_time": departure_time,
            "arrival_time": arrival_time,
            "flight_duration": flight_duration,
            "stops": num_stops,
            "carrier_name": segment.get("carrierCode", "")
        })

    # Sort by price
    flights_data.sort(key=lambda x: x["price"])
    
    return flights_data

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
        flight_info["flight_number"],
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
# FORMAT FLIGHT SUMMARY
# ----------------------------
def format_flight_summary(flights_data):
    if not flights_data:
        return "No flights found for this route and date."
    
    summary = f"""
FLIGHT SUMMARY: {ORIGIN} → {DESTINATION} on {DEPARTURE_DATE}
{'=' * 80}

Found {len(flights_data)} flight option(s):

"""
    
    target_found = False
    alerts_triggered = []
    
    for idx, flight in enumerate(flights_data, 1):
        is_target = flight["flight_number"] == TARGET_FLIGHT_NUMBER
        if is_target:
            target_found = True
        
        alert_indicator = ""
        if flight["price"] <= MAX_PRICE_ALERT:
            alert_indicator += "💰 PRICE ALERT "
            alerts_triggered.append(flight)
        if flight["seats"] <= MIN_SEATS_ALERT:
            alert_indicator += "💺 LOW SEATS "
            if flight not in alerts_triggered:
                alerts_triggered.append(flight)
        
        target_indicator = "⭐ TARGET FLIGHT ⭐" if is_target else ""
        
        stops_text = "Direct" if flight["stops"] == 0 else f"{flight['stops']} stop(s)"
        
        summary += f"""
{idx}. {flight['flight_number']} ({flight['carrier_name']}) {target_indicator} {alert_indicator}
   Price: {flight['price']:.2f} {flight['currency']} | Seats: {flight['seats']} | Stops: {stops_text}
   Fare Class: {flight['fare_class']} | Aircraft: {flight['aircraft']} | Cabin: {flight['cabin']}
   Departure: {flight['departure_time']} → Arrival: {flight['arrival_time']}
   Duration: {flight['flight_duration']}
{'-' * 80}
"""
    
    # Add alert summary
    if alerts_triggered:
        summary += f"\n\n🚨 {len(alerts_triggered)} ALERT(S) TRIGGERED:\n"
        summary += f"Alert Conditions: Price ≤ {MAX_PRICE_ALERT} AUD OR Seats ≤ {MIN_SEATS_ALERT}\n"
    
    # Add target flight status
    if not target_found:
        summary += f"\n\n⚠️  WARNING: Target flight {TARGET_FLIGHT_NUMBER} NOT FOUND in results.\n"
        summary += "This could mean:\n"
        summary += "- Flight number is incorrect\n"
        summary += "- Flight is not available on this date\n"
        summary += "- Flight is not bookable through this API\n"
    
    return summary

# ----------------------------
# EMAIL SUMMARY
# ----------------------------
def send_email_summary(flights_data):
    summary = format_flight_summary(flights_data)
    
    # Determine if this is an alert email or just a summary
    has_alerts = any(f["price"] <= MAX_PRICE_ALERT or f["seats"] <= MIN_SEATS_ALERT for f in flights_data)
    subject_prefix = "🚨 ALERT: " if has_alerts else "📊 Summary: "
    
    msg = MIMEMultipart()
    msg["Subject"] = f"{subject_prefix}Flight Tracker - {ORIGIN} to {DESTINATION}"
    msg["From"] = EMAIL_FROM
    msg["To"] = EMAIL_TO
    
    msg.attach(MIMEText(summary, "plain"))
    
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(EMAIL_FROM, EMAIL_PASSWORD)
        server.send_message(msg)

# ----------------------------
# CHECK FLIGHTS
# ----------------------------
def check_flights():
    try:
        print(f"\n{'=' * 80}")
        print(f"Checking flights: {ORIGIN} → {DESTINATION} on {DEPARTURE_DATE}")
        print(f"{'=' * 80}\n")
        
        flights_data = fetch_all_flights()
        
        # Store each flight in database
        for flight in flights_data:
            store_data(flight)
        
        # Print summary to console
        print(format_flight_summary(flights_data))
        
        # Send email with all flight details
        send_email_summary(flights_data)
        print(f"\n✅ Email sent to {EMAIL_TO}")
        print(f"Total flights checked: {len(flights_data)}")
        
    except Exception as e:
        print(f"❌ ERROR: {e}")
        import traceback
        traceback.print_exc()

# ----------------------------
# MAIN EXECUTION
# ----------------------------
if __name__ == "__main__":
    init_db()
    check_flights()

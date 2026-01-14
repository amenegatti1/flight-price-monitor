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
TARGET_FLIGHT_NUMBER = "TH168"

MAX_PRICE_FILTER = 700.00  # Only include flights cheaper than this
MAX_PRICE_ALERT = 1200.00  # Additional alert threshold
MIN_SEATS_ALERT = 3

DB_FILE = "prices.db"

# ----------------------------
# AIRLINE CODE TO NAME MAPPING
# ----------------------------
AIRLINE_NAMES = {
    "TH": "Thai Airways",
    "SQ": "Singapore Airlines",
    "TR": "Scoot",
    "3K": "Jetstar Asia",
    "JQ": "Jetstar Airways",
    "QF": "Qantas",
    "EK": "Emirates",
    "QR": "Qatar Airways",
    "CX": "Cathay Pacific",
    "MH": "Malaysia Airlines",
    "AK": "AirAsia",
    "D7": "AirAsia X",
    "FD": "Thai AirAsia",
    "GA": "Garuda Indonesia",
    "TG": "Thai Airways International",
    "VA": "Virgin Australia",
    "NZ": "Air New Zealand",
    "CI": "China Airlines",
    "BR": "EVA Air",
    "NH": "All Nippon Airways",
    "JL": "Japan Airlines",
    "OZ": "Asiana Airlines",
    "KE": "Korean Air",
    "VN": "Vietnam Airlines",
    "BL": "Jetstar Pacific",
    "PR": "Philippine Airlines",
    "5J": "Cebu Pacific"
}

def get_airline_name(carrier_code):
    """Get full airline name from carrier code"""
    return AIRLINE_NAMES.get(carrier_code, carrier_code)

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
            airline_name TEXT,
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
        "maxPrice": MAX_PRICE_FILTER,  # Filter by price in API call
        "max": 250,
        "nonStop": "false"
    }

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    offers = response.json()["data"]

    flights_data = []
    seen_flights = set()

    for offer in offers:
        segment = offer["itineraries"][0]["segments"][0]
        carrier_code = segment.get("carrierCode", "")
        flight_no = f"{carrier_code}{segment['number']}"
        
        if flight_no in seen_flights:
            continue
        seen_flights.add(flight_no)

        price = float(offer["price"]["total"])
        
        # Double-check price filter (in case API doesn't filter perfectly)
        if price > MAX_PRICE_FILTER:
            continue

        seats = offer.get("numberOfBookableSeats", 0)
        currency = offer["price"]["currency"]
        
        fare_class = "N/A"
        if "travelerPricings" in offer and len(offer["travelerPricings"]) > 0:
            fare_details = offer["travelerPricings"][0].get("fareDetailsBySegment", [])
            if fare_details:
                fare_class = fare_details[0].get("class", "N/A")
        
        aircraft = segment.get("aircraft", {}).get("code", "N/A")
        cabin = segment.get("cabin", "N/A")
        departure_time = segment["departure"]["at"]
        arrival_time = segment["arrival"]["at"]
        flight_duration = offer["itineraries"][0].get("duration", "N/A")
        num_stops = len(offer["itineraries"][0]["segments"]) - 1
        
        # Get airline name
        airline_name = get_airline_name(carrier_code)
        
        flights_data.append({
            "flight_number": flight_no,
            "carrier_code": carrier_code,
            "airline_name": airline_name,
            "price": price,
            "seats": seats,
            "currency": currency,
            "fare_class": fare_class,
            "aircraft": aircraft,
            "cabin": cabin,
            "departure_time": departure_time,
            "arrival_time": arrival_time,
            "flight_duration": flight_duration,
            "stops": num_stops
        })

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
        (checked_at, flight_number, airline_name, price, seats_left, currency, fare_class, aircraft, cabin, departure_time, arrival_time, flight_duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        datetime.utcnow().isoformat(),
        flight_info["flight_number"],
        flight_info["airline_name"],
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
        return f"""
NO FLIGHTS FOUND

Route: {ORIGIN} → {DESTINATION} on {DEPARTURE_DATE}
Price Filter: Under {MAX_PRICE_FILTER:.2f} AUD

No flights found matching the price criteria.
This could mean:
- All available flights are above ${MAX_PRICE_FILTER:.2f}
- No flights available for this date
- API limitations

Try increasing MAX_PRICE_FILTER in the configuration.
"""
    
    summary = f"""
FLIGHT SUMMARY: {ORIGIN} → {DESTINATION} on {DEPARTURE_DATE}
Price Filter: Flights under ${MAX_PRICE_FILTER:.2f} AUD
{'=' * 90}

Found {len(flights_data)} flight option(s) under ${MAX_PRICE_FILTER:.2f}:

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
{idx}. {flight['airline_name']} - {flight['flight_number']} {target_indicator} {alert_indicator}
   Price: ${flight['price']:.2f} {flight['currency']} | Seats Available: {flight['seats']} | Stops: {stops_text}
   Fare Class: {flight['fare_class']} | Aircraft: {flight['aircraft']} | Cabin: {flight['cabin']}
   Departure: {flight['departure_time']} → Arrival: {flight['arrival_time']}
   Duration: {flight['flight_duration']}
{'-' * 90}
"""
    
    if alerts_triggered:
        summary += f"\n\n🚨 {len(alerts_triggered)} ALERT(S) TRIGGERED:\n"
        summary += f"Alert Conditions: Price ≤ ${MAX_PRICE_ALERT:.2f} AUD OR Seats ≤ {MIN_SEATS_ALERT}\n"
    
    if not target_found:
        summary += f"\n\n⚠️  WARNING: Target flight {TARGET_FLIGHT_NUMBER} NOT FOUND in results under ${MAX_PRICE_FILTER:.2f}.\n"
        summary += "This could mean:\n"
        summary += f"- Flight is priced above ${MAX_PRICE_FILTER:.2f}\n"
        summary += "- Flight number is incorrect\n"
        summary += "- Flight is not available on this date\n"
        summary += "- Flight is not bookable through this API\n"
    
    return summary

# ----------------------------
# EMAIL SUMMARY
# ----------------------------
def send_email_summary(flights_data):
    summary = format_flight_summary(flights_data)
    
    has_alerts = any(f["price"] <= MAX_PRICE_ALERT or f["seats"] <= MIN_SEATS_ALERT for f in flights_data)
    
    if not flights_data:
        subject_prefix = "⚠️ No Results: "
    elif has_alerts:
        subject_prefix = "🚨 ALERT: "
    else:
        subject_prefix = "📊 Summary: "
    
    msg = MIMEMultipart()
    msg["Subject"] = f"{subject_prefix}Flight Tracker - {ORIGIN} to {DESTINATION} (Under ${MAX_PRICE_FILTER})"
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
        print(f"\n{'=' * 90}")
        print(f"Checking flights: {ORIGIN} → {DESTINATION} on {DEPARTURE_DATE}")
        print(f"Price Filter: Under ${MAX_PRICE_FILTER:.2f} AUD")
        print(f"{'=' * 90}\n")
        
        flights_data = fetch_all_flights()
        
        for flight in flights_data:
            store_data(flight)
        
        print(format_flight_summary(flights_data))
        
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

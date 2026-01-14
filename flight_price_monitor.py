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
DEPARTURE_DATES = ["2026-02-15", "2026-02-16"]  # Check multiple dates

MAX_PRICE_FILTER = 700.00  # Only include flights cheaper than this
MAX_PRICE_ALERT = 1200.00  # Additional alert threshold
MIN_SEATS_ALERT = 3
DIRECT_ONLY = True  # Only include direct flights

DB_FILE = "prices.db"

# ----------------------------
# AIRLINE CODE TO NAME MAPPING
# ----------------------------
AIRLINE_NAMES = {
    "TK": "Turkish Airlines",
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
            departure_date TEXT,
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
            flight_duration TEXT,
            price_quartile TEXT,
            historical_min REAL,
            historical_max REAL
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
# FLIGHT PRICE ANALYSIS
# ----------------------------
def get_price_analysis(token, origin, destination, departure_date):
    """Get historical price analysis for a route"""
    try:
        url = "https://test.api.amadeus.com/v1/analytics/itinerary-price-metrics"
        headers = {"Authorization": f"Bearer {token}"}
        params = {
            "originIataCode": origin,
            "destinationIataCode": destination,
            "departureDate": departure_date,
            "currencyCode": "AUD"
        }
        
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        data = response.json()["data"][0]
        
        price_metrics = data.get("priceMetrics", [])
        if price_metrics:
            metrics = price_metrics[0]
            quartiles = metrics.get("quartileRanking", "UNKNOWN")
            min_price = metrics.get("minimum", 0)
            max_price = metrics.get("maximum", 0)
            median = metrics.get("median", 0)
            
            return {
                "quartile": quartiles,
                "min": min_price,
                "max": max_price,
                "median": median,
                "available": True
            }
    except Exception as e:
        print(f"   ℹ️  Price analysis unavailable: {e}")
    
    return {"quartile": "N/A", "min": 0, "max": 0, "median": 0, "available": False}

# ----------------------------
# FETCH ALL FLIGHTS DATA FOR A SINGLE DATE
# ----------------------------
def fetch_flights_for_date(departure_date, token):
    url = "https://test.api.amadeus.com/v2/shopping/flight-offers"
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "originLocationCode": ORIGIN,
        "destinationLocationCode": DESTINATION,
        "departureDate": departure_date,
        "adults": 1,
        "currencyCode": "AUD",
        "max": 250,
        "nonStop": "true" if DIRECT_ONLY else "false"
    }

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    offers = response.json()["data"]

    flights_data = []
    seen_flights = set()
    total_flights_found = 0

    for offer in offers:
        segment = offer["itineraries"][0]["segments"][0]
        carrier_code = segment.get("carrierCode", "")
        flight_no = f"{carrier_code}{segment['number']}"
        
        total_flights_found += 1
        
        if flight_no in seen_flights:
            continue
        seen_flights.add(flight_no)

        price = float(offer["price"]["total"])
        
        # Filter by price AFTER fetching
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
            "stops": num_stops,
            "departure_date": departure_date
        })

    flights_data.sort(key=lambda x: x["price"])
    
    print(f"📊 {departure_date}: Total offers returned by API: {total_flights_found}")
    filter_msg = f"Direct flights under ${MAX_PRICE_FILTER}" if DIRECT_ONLY else f"Flights under ${MAX_PRICE_FILTER}"
    print(f"✅ {departure_date}: {filter_msg}: {len(flights_data)}")
    
    return flights_data

# ----------------------------
# STORE DATA
# ----------------------------
def store_data(flight_info):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO flight_prices
        (checked_at, departure_date, flight_number, airline_name, price, seats_left, currency, fare_class, aircraft, cabin, departure_time, arrival_time, flight_duration, price_quartile, historical_min, historical_max)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        datetime.utcnow().isoformat(),
        flight_info["departure_date"],
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
        flight_info["flight_duration"],
        flight_info.get("price_quartile", "N/A"),
        flight_info.get("historical_min", 0),
        flight_info.get("historical_max", 0)
    ))
    conn.commit()
    conn.close()

# ----------------------------
# FORMAT FLIGHT SUMMARY FOR A SINGLE DATE
# ----------------------------
def format_date_summary(departure_date, flights_data, price_analysis):
    if not flights_data:
        return f"""
{'=' * 90}
DATE: {departure_date}
{'=' * 90}

NO FLIGHTS FOUND UNDER ${MAX_PRICE_FILTER:.2f}

No flights found matching the price criteria for this date.
This could mean:
- All available flights are above ${MAX_PRICE_FILTER:.2f}
- No flights available for this date
- Limited availability in the API results
"""
    
    summary = f"""
{'=' * 90}
DATE: {departure_date}
{'=' * 90}
"""
    
    # Add historical price context if available
    if price_analysis.get("available"):
        summary += f"""
📊 HISTORICAL PRICE ANALYSIS:
   Price Range: ${price_analysis['min']:.2f} - ${price_analysis['max']:.2f} AUD (Median: ${price_analysis['median']:.2f})
   Current Quartile: {price_analysis['quartile']}
   {'✅ EXCELLENT DEAL!' if price_analysis['quartile'] in ['FIRST', 'MINIMUM'] else ''}
   {'✅ GOOD PRICE' if price_analysis['quartile'] == 'SECOND' else ''}
   {'⚠️  ABOVE AVERAGE' if price_analysis['quartile'] == 'THIRD' else ''}
   {'⚠️  HIGH PRICE' if price_analysis['quartile'] in ['FOURTH', 'MAXIMUM'] else ''}
"""
    
    summary += f"\nFound {len(flights_data)} flight option(s) under ${MAX_PRICE_FILTER:.2f}:\n\n"
    
    alerts_triggered = []
    
    for idx, flight in enumerate(flights_data, 1):
        alert_indicator = ""
        if flight["price"] <= MAX_PRICE_ALERT:
            alert_indicator += "💰 PRICE ALERT "
            if flight not in alerts_triggered:
                alerts_triggered.append(flight)
        if flight["seats"] <= MIN_SEATS_ALERT:
            alert_indicator += "💺 LOW SEATS "
            if flight not in alerts_triggered:
                alerts_triggered.append(flight)
        
        # Add historical context indicator
        historical_indicator = ""
        if price_analysis.get("available"):
            if flight["price"] <= price_analysis["median"]:
                historical_indicator = "🌟 BELOW MEDIAN "
        
        stops_text = "Direct" if flight["stops"] == 0 else f"{flight['stops']} stop(s)"
        
        summary += f"""
{idx}. {flight['airline_name']} - {flight['flight_number']} {historical_indicator}{alert_indicator}
   Price: ${flight['price']:.2f} {flight['currency']} | Seats Available: {flight['seats']} | Stops: {stops_text}
   Fare Class: {flight['fare_class']} | Aircraft: {flight['aircraft']} | Cabin: {flight['cabin']}
   Departure: {flight['departure_time']} → Arrival: {flight['arrival_time']}
   Duration: {flight['flight_duration']}
{'-' * 90}
"""
    
    if alerts_triggered:
        summary += f"\n🚨 {len(alerts_triggered)} ALERT(S) for {departure_date}\n"
    
    return summary

# ----------------------------
# FORMAT COMBINED SUMMARY FOR ALL DATES
# ----------------------------
def format_combined_summary(all_flights_by_date, all_price_analysis):
    filter_desc = f"Direct flights under ${MAX_PRICE_FILTER:.2f} AUD" if DIRECT_ONLY else f"Flights under ${MAX_PRICE_FILTER:.2f} AUD"
    header = f"""
FLIGHT SUMMARY: {ORIGIN} → {DESTINATION}
Dates Checked: {', '.join(DEPARTURE_DATES)}
Price Filter: {filter_desc}
{'=' * 90}
"""
    
    # Summary stats
    total_flights = sum(len(flights) for flights in all_flights_by_date.values())
    total_alerts = 0
    
    for flights in all_flights_by_date.values():
        for flight in flights:
            if flight["price"] <= MAX_PRICE_ALERT or flight["seats"] <= MIN_SEATS_ALERT:
                total_alerts += 1
                break
    
    header += f"\nTotal flights found across all dates: {total_flights}\n"
    if total_alerts > 0:
        header += f"🚨 ALERTS: {total_alerts} date(s) have triggered alerts\n"
    
    # Day-by-day breakdown
    day_summaries = []
    for date in DEPARTURE_DATES:
        flights = all_flights_by_date.get(date, [])
        analysis = all_price_analysis.get(date, {})
        day_summaries.append(format_date_summary(date, flights, analysis))
    
    full_summary = header + "\n" + "\n".join(day_summaries)
    
    # Overall alert summary
    full_summary += f"\n\n{'=' * 90}\n"
    full_summary += f"ALERT CONDITIONS: Price ≤ ${MAX_PRICE_ALERT:.2f} AUD OR Seats ≤ {MIN_SEATS_ALERT}\n"
    full_summary += f"{'=' * 90}\n"
    
    return full_summary

# ----------------------------
# EMAIL SUMMARY
# ----------------------------
def send_email_summary(all_flights_by_date, all_price_analysis):
    summary = format_combined_summary(all_flights_by_date, all_price_analysis)
    
    # Check for alerts across all dates
    has_alerts = False
    total_flights = 0
    
    for flights in all_flights_by_date.values():
        total_flights += len(flights)
        for flight in flights:
            if flight["price"] <= MAX_PRICE_ALERT or flight["seats"] <= MIN_SEATS_ALERT:
                has_alerts = True
                break
    
    if total_flights == 0:
        subject_prefix = "⚠️ No Results: "
    elif has_alerts:
        subject_prefix = "🚨 ALERT: "
    else:
        subject_prefix = "📊 Summary: "
    
    date_range = f"{DEPARTURE_DATES[0]} to {DEPARTURE_DATES[-1]}" if len(DEPARTURE_DATES) > 1 else DEPARTURE_DATES[0]
    
    msg = MIMEMultipart()
    msg["Subject"] = f"{subject_prefix}Flight Tracker - {ORIGIN} to {DESTINATION} ({date_range})"
    msg["From"] = EMAIL_FROM
    msg["To"] = EMAIL_TO
    
    msg.attach(MIMEText(summary, "plain"))
    
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(EMAIL_FROM, EMAIL_PASSWORD)
        server.send_message(msg)

# ----------------------------
# CHECK FLIGHTS FOR ALL DATES
# ----------------------------
def check_flights():
    try:
        print(f"\n{'=' * 90}")
        print(f"Checking flights: {ORIGIN} → {DESTINATION}")
        print(f"Dates: {', '.join(DEPARTURE_DATES)}")
        print(f"Price Filter: Under ${MAX_PRICE_FILTER:.2f} AUD")
        print(f"{'=' * 90}\n")
        
        token = get_access_token()
        
        all_flights_by_date = {}
        all_price_analysis = {}
        
        # Fetch flights and price analysis for each date
        for date in DEPARTURE_DATES:
            print(f"\nFetching flights for {date}...")
            flights = fetch_flights_for_date(date, token)
            all_flights_by_date[date] = flights
            
            # Get price analysis for this route
            print(f"Fetching price analysis for {date}...")
            analysis = get_price_analysis(token, ORIGIN, DESTINATION, date)
            all_price_analysis[date] = analysis
            
            # Add price analysis to flights
            for flight in flights:
                flight["price_quartile"] = analysis.get("quartile", "N/A")
                flight["historical_min"] = analysis.get("min", 0)
                flight["historical_max"] = analysis.get("max", 0)
            
            # Store in database
            for flight in flights:
                store_data(flight)
        
        # Print summary
        print("\n" + format_combined_summary(all_flights_by_date, all_price_analysis))
        
        # Send email
        send_email_summary(all_flights_by_date, all_price_analysis)
        print(f"\n✅ Email sent to {EMAIL_TO}")
        
        total_flights = sum(len(flights) for flights in all_flights_by_date.values())
        print(f"Total flights found across all dates: {total_flights}")
        
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

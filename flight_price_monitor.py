import requests
import sqlite3
import schedule
import time
from datetime import datetime
import smtplib
from email.mime.text import MIMEText

# ----------------------------
# CONFIGURATION
# ----------------------------

AMADEUS_API_KEY = "YOUR_API_KEY"
AMADEUS_API_SECRET = "YOUR_API_SECRET"

ORIGIN = "SYD"
DESTINATION = "LAX"
DEPARTURE_DATE = "2026-03-10"
MAX_PRICE_ALERT = 1200.00  # AUD

CHECK_INTERVAL_MINUTES = 60

EMAIL_FROM = "your_email@gmail.com"
EMAIL_TO = "your_email@gmail.com"
EMAIL_PASSWORD = "your_app_password"

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
            price REAL,
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
        "client_id": AMZPEEVFyWD2kM4CG7LY0YI8dGFYjU9p3,
        "client_secret": zqJ78pJKTxg74GCN
    }

    response = requests.post(url, data=data)
    response.raise_for_status()
    return response.json()["access_token"]

# ----------------------------
# FETCH FLIGHT PRICE
# ----------------------------

def fetch_flight_price():
    token = get_access_token()

    url = "https://test.api.amadeus.com/v2/shopping/flight-offers"
    headers = {
        "Authorization": f"Bearer {token}"
    }
    params = {
        "originLocationCode": ORIGIN,
        "destinationLocationCode": DESTINATION,
        "departureDate": DEPARTURE_DATE,
        "adults": 1,
        "currencyCode": "AUD",
        "max": 1
    }

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()

    data = response.json()
    offer = data["data"][0]
    price = float(offer["price"]["total"])
    currency = offer["price"]["currency"]

    return price, currency

# ----------------------------
# STORE PRICE
# ----------------------------

def store_price(price, currency):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute("""
        INSERT INTO flight_prices (checked_at, price, currency)
        VALUES (?, ?, ?)
    """, (datetime.utcnow().isoformat(), price, currency))

    conn.commit()
    conn.close()

# ----------------------------
# ALERTING
# ----------------------------

def send_email_alert(price):
    body = f"""
    Flight price alert!

    Route: {ORIGIN} → {DESTINATION}
    Departure: {DEPARTURE_DATE}
    Current Price: {price} AUD
    Alert Threshold: {MAX_PRICE_ALERT} AUD
    """

    msg = MIMEText(body)
    msg["Subject"] = "✈️ Flight Price Alert"
    msg["From"] = EMAIL_FROM
    msg["To"] = EMAIL_TO

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(EMAIL_FROM, EMAIL_PASSWORD)
        server.send_message(msg)

# ----------------------------
# CHECK LOGIC
# ----------------------------

def check_price():
    try:
        price, currency = fetch_flight_price()
        store_price(price, currency)

        print(f"[{datetime.now()}] Price checked: {price} {currency}")

        if price <= MAX_PRICE_ALERT:
            send_email_alert(price)
            print("ALERT SENT")

    except Exception as e:
        print(f"ERROR: {e}")

# ----------------------------
# SCHEDULER
# ----------------------------

def main():
    init_db()
    check_price()

    schedule.every(CHECK_INTERVAL_MINUTES).minutes.do(check_price)

    while True:
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    main()

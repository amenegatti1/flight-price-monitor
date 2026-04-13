import requests
from bs4 import BeautifulSoup
import os
from datetime import datetime

def get_ipad_price():
    url = "https://www.jbhifi.com.au/products/apple-ipad-mini-8-3-inch-wi-fi-256gb-space-greya17-pro-chip"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Try meta tag first as it's very reliable
        meta_price = soup.find('meta', property='og:price:amount')
        if meta_price and meta_price.get('content'):
            return float(meta_price.get('content'))
            
        # Fallback to other meta tags
        meta_schema = soup.find('meta', itemprop='price')
        if meta_schema and meta_schema.get('content'):
            return float(meta_schema.get('content'))
            
        return None
    except Exception as e:
        print(f"Error fetching price: {e}")
        return None

def send_telegram_message(message):
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    
    if not token or not chat_id:
        print("Telegram credentials not found in environment variables.")
        return
        
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "Markdown"
    }
    
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
        print("Telegram message sent successfully.")
    except Exception as e:
        print(f"Error sending Telegram message: {e}")

if __name__ == "__main__":
    print(f"Checking iPad mini 7 price at {datetime.now()}...")
    price = get_ipad_price()
    
    if price:
        message = f"📱 *iPad mini 7 (256GB) Price Update*\n\nToday's price at JB Hi-Fi: *${price:,.2f}*\n\n[View Product](https://www.jbhifi.com.au/products/apple-ipad-mini-8-3-inch-wi-fi-256gb-space-greya17-pro-chip)"
        print(f"Price found: ${price}")
        send_telegram_message(message)
    else:
        print("Could not retrieve price.")

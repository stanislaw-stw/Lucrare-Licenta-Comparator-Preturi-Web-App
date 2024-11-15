import sys
import time
import asyncio
import aiohttp
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import NoSuchElementException, TimeoutException

driver = webdriver.Chrome()

driver.get("https://cel.ro/")

backend_url = "http://localhost:3000/addProduct"


async def send_post_request(session, url, payload, retries=5):
    for attempt in range(retries):
        try:
            print(f"Sending POST request to {url}, attempt {attempt + 1}")
            async with session.post(url, json=payload) as response:
                response_text = await response.text()
                if response.status == 201:
                    print("Product added successfully.")
                    return
                else:
                    print(f"Failed to add product: {response_text}")
        except aiohttp.client_exceptions.ServerDisconnectedError as e:
            print(f"Server disconnected: {e}")
            if attempt < retries - 1:
                wait_time = 2 ** attempt
                print(f"Retrying in {wait_time} seconds...")
                await asyncio.sleep(wait_time)
            else:
                print("Max retries reached. Giving up.")
        except Exception as e:
            print(f"Unexpected error: {e}")
            break


async def main(keyword):
    async with aiohttp.ClientSession() as session:
        try:
            time.sleep(2)
            WebDriverWait(driver, 75).until(
                lambda d: d.execute_script('return document.readyState') == 'complete'
            )
            search_box = WebDriverWait(driver, 75).until(
                EC.presence_of_element_located((By.ID, "keyword"))
            )
            search_box.click()
            search_box.send_keys(keyword)
            search_box.send_keys(Keys.ENTER)
            time.sleep(3)

            current_page = 1
            max_pages = 2
            products_final = []
            while True:
                print(f"Processing page {current_page}...")
                WebDriverWait(driver, 75).until(
                    EC.presence_of_all_elements_located((By.CLASS_NAME, "productListing-tot"))
                )
                print("Search results loaded.")

                products = driver.find_elements(By.CLASS_NAME, "product_data")
                print(f"Found {len(products)} products on the page.")

                for product in products:
                    try:
                        price = product.find_element(By.CSS_SELECTOR, "div.pret_n > span.price").text
                    except NoSuchElementException:
                        price = "N/A"

                    try:
                        title_element = product.find_element(By.CLASS_NAME, "productTitle")
                        title = title_element.find_element(By.TAG_NAME, "span").text
                        product_url = title_element.find_element(By.TAG_NAME, "a").get_attribute("href")
                    except NoSuchElementException:
                        title = "N/A"
                        product_url = "N/A"

                    try:
                        img_element = product.find_element(By.CSS_SELECTOR, "div.productListing-poza > a > img")
                        image_url = img_element.get_attribute("src")
                    except NoSuchElementException:
                        image_url = "N/A"

                    try:
                        inStock = product.find_element(By.XPATH,
                                                       "//div[@class='stoc_list infoStocElem']//strong[contains(@class, 'info_stoc')]").text
                    except NoSuchElementException:
                        inStock = "N/A"

                    print(f"Title: {title}, Price: {price}, Product URL: {product_url}, In Stock: {inStock}")
                    payload = {
                        'title': title,
                        'spec1': product_url,
                        'spec2': inStock,
                        'spec3': 'cel',
                        'spec4': '',
                        'spec5': '',
                        'spec6': '',
                        'spec7': '',
                        'spec8': '',
                        'spec9': '',
                        'spec10': '',
                        'spec11': '',
                        'spec12': '',
                        'spec13': '',
                        'spec14': '',
                        'spec15': '',
                        'image_url': image_url,
                        'category': '',
                        'subcategory': keyword,
                        'price': price
                    }
                    products_final.append(payload)



                if products:
                    last_product = products[-1]
                    driver.execute_script("arguments[0].scrollIntoView(true);", last_product)
                    time.sleep(2)
                    print("Scrolled to the last product.")
                    time.sleep(3)


                next_page_button = driver.find_elements(By.CSS_SELECTOR, "a.last")
                if next_page_button and current_page < max_pages:
                    time.sleep(1.5)
                    current_page += 1
                    next_page_button[0].click()
                    print(f"Navigating to page {current_page}...")
                    time.sleep(1)
                    WebDriverWait(driver, 75).until(
                        lambda d: d.execute_script('return document.readyState') == 'complete'
                    )
                else:
                    for product in products_final:
                        driver.get(product.get('spec1'))
                        WebDriverWait(driver, 75).until(
                            lambda d: d.execute_script('return document.readyState') == 'complete'
                        )
                        try:
                            WebDriverWait(driver, 10).until(
                                EC.visibility_of_element_located((By.CSS_SELECTOR, "div.caracteristici-wrapper"))
                            )
                            table = WebDriverWait(driver, 4).until(
                                EC.visibility_of_element_located(
                                    (By.CSS_SELECTOR, "table.caractTable:not(.sticky-table)"))
                            )
                            rows = table.find_elements(By.CSS_SELECTOR, "tbody tr")
                            specs = {}
                            for idx, row in enumerate(rows, start = 1):
                                tds = row.find_elements(By.TAG_NAME, "td")
                                if len(tds) == 2:
                                    spec_label = tds[0].text.strip()
                                    spec_value = tds[1].text.strip()
                                    specs[f'spec{idx}'] = f"{spec_label}: {spec_value}"
                                if idx == 10:
                                    break
                            product['spec4'] = specs.get('spec1', '')
                            product['spec5'] = specs.get('spec2', '')
                            product['spec6'] = specs.get('spec3', '')
                            product['spec7'] = specs.get('spec4', '')
                            product['spec8'] = specs.get('spec5', '')
                            product['spec9'] = specs.get('spec6', '')
                            product['spec10'] = specs.get('spec7', '')
                            product['spec11'] = specs.get('spec8', '')
                            product['spec12'] = specs.get('spec9', '')
                            product['spec13'] = specs.get('spec10', '')

                            await send_post_request(session, backend_url, product)
                            time.sleep(1)
                        except TimeoutException:
                            print("Page load timed out.")
                            await send_post_request(session, backend_url, product)

                        except NoSuchElementException:
                            print("Characteristics table not found.")
                            await send_post_request(session, backend_url, product)
                        # spec11 -brand
                    print("No more pages to load.")
                    break
        except TimeoutException:
            print("Page load timed out.")
        finally:
            driver.quit()
            print("Driver quit.")


if len(sys.argv) > 1:
    keyword = sys.argv[1]
    asyncio.run(main(keyword))
else:
    print("Please provide a keyword as the first argument.")


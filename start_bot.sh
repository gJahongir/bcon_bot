#!/bin/bash

# bcon_bot ni ishga tushirish skripti
# Server yonganda bot avtomatik ishga tushadi

BOT_DIR="/home/jdserver/server/bcon_bot"
LOG_DIR="$BOT_DIR/logs"
PID_FILE="$BOT_DIR/.bot.pid"

mkdir -p "$LOG_DIR"

cd "$BOT_DIR" || exit 1

# Agar bot allaqachon ishlayotgan bo'lsa, qayta ishga tushirmaydi
if pgrep -f "node bot/index.js" > /dev/null; then
    echo "$(date): Bot allaqachon ishlayapti" >> "$LOG_DIR/bot.log"
    exit 0
fi

# O'lgan jarayondan qolgan lock fayllarni tozalash
rm -f "$BOT_DIR/.bot.lock" "$PID_FILE"

# Botni ishga tushirish
nohup npm run bot >> "$LOG_DIR/bot.log" 2>&1 &
BOT_PID=$!
echo $BOT_PID > "$PID_FILE"

echo "$(date): Bot ishga tushdi (PID: $BOT_PID)" >> "$LOG_DIR/bot.log"

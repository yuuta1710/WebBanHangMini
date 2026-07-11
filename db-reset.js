const pool = require('./db');

async function resetOrdersTable() {
  console.log('🔄 Đang tiến hành xóa dữ liệu và reset ID bảng orders...');
  try {
    // Sử dụng lệnh TRUNCATE kết hợp RESTART IDENTITY để dọn dẹp sạch sẽ
    const queryText = 'TRUNCATE TABLE orders RESTART IDENTITY CASCADE;';
    
    await pool.query(queryText);
    console.log('✅ Đã dọn dẹp bảng orders và đưa ID tự tăng về số 1 thành công!');
  } catch (err) {
    console.error('❌ Lỗi trong quá trình thực thi lệnh SQL:', err.message);
  } finally {
    // Đóng pool kết nối để kết thúc script Node.js
    await pool.end();
    console.log('🔌 Đã ngắt kết nối an toàn.');
    process.exit(0);
  }
}

resetOrdersTable();